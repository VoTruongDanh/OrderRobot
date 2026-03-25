import { useEffect, useRef, useState } from 'react'
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition'

import {
  type StreamingSpeechEvent,
  type StreamingSpeechFinalEvent,
  StreamingSpeechClient,
  synthesizeSpeech,
  transcribeSpeech,
} from '../api'

type UseSpeechOptions = {
  lang: string
  onTranscript: (transcript: string) => void
  onPartialTranscript?: (transcript: string) => void
  onNotice: (message: string, level?: 'warning' | 'info') => void
}

export type SpeechCapturePhase = 'idle' | 'listening' | 'processing'

const MAX_RECORDING_MS = 15000
const RECORDER_CHUNK_MS = 180
const MIN_SPEECH_CAPTURE_MS = 350
const SILENCE_STOP_MS = 520
const SILENCE_RMS_THRESHOLD = 0.02
const BROWSER_FINAL_WAIT_MS = 600
const STREAMING_FINAL_WAIT_MS = 3200
const STREAMING_READY_WAIT_MS = 1400
const STREAMING_FLUSH_INTERVAL_MS = 220
const REPEATED_TRANSCRIPT_WINDOW_MS = 15000

const AMBIENT_WATERMARK_PATTERNS = [
  /subscribe/,
  /kenh/,
  /dang ky kenh/,
  /video hap dan/,
  /dung bo lo/,
  /don t bo lo/,
  /like va share/,
]

export function useSpeech({ lang, onTranscript, onPartialTranscript, onNotice }: UseSpeechOptions) {
  const transcriptHandlerRef = useRef(onTranscript)
  const partialTranscriptHandlerRef = useRef(onPartialTranscript)
  const noticeHandlerRef = useRef(onNotice)
  const notifiedKeysRef = useRef<Set<string>>(new Set())

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const stopTimerRef = useRef<number | null>(null)
  const silenceCheckFrameRef = useRef<number | null>(null)
  const speechStartedAtRef = useRef<number | null>(null)
  const silenceStartedAtRef = useRef<number | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const mediaSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const analysisBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const streamingClientRef = useRef<StreamingSpeechClient | null>(null)
  const streamingReadyPromiseRef = useRef<Promise<boolean> | null>(null)
  const streamingFinalPromiseRef = useRef<Promise<StreamingSpeechFinalEvent | null> | null>(null)
  const resolveStreamingFinalRef = useRef<((value: StreamingSpeechFinalEvent | null) => void) | null>(null)
  const latestStreamingPartialRef = useRef('')
  const lastStreamingFlushAtRef = useRef(0)

  const lastAcceptedTranscriptRef = useRef<{ text: string; at: number } | null>(null)
  const latestBrowserTranscriptRef = useRef('')
  const latestBrowserFinalTranscriptRef = useRef('')

  const [listening, setListening] = useState(false)
  const [capturePhase, setCapturePhase] = useState<SpeechCapturePhase>('idle')

  const {
    transcript,
    finalTranscript,
    resetTranscript,
    browserSupportsSpeechRecognition,
    isMicrophoneAvailable,
  } = useSpeechRecognition({
    clearTranscriptOnListen: true,
  })

  const captureSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  const recognitionSupported = captureSupported
  const synthesisSupported = typeof window !== 'undefined' && typeof Audio !== 'undefined'

  useEffect(() => {
    transcriptHandlerRef.current = onTranscript
    partialTranscriptHandlerRef.current = onPartialTranscript
    noticeHandlerRef.current = onNotice
  }, [onNotice, onPartialTranscript, onTranscript])

  useEffect(() => {
    latestBrowserTranscriptRef.current = transcript.trim()
    if (listening && latestBrowserTranscriptRef.current) {
      partialTranscriptHandlerRef.current?.(latestBrowserTranscriptRef.current)
    }
  }, [listening, transcript])

  useEffect(() => {
    latestBrowserFinalTranscriptRef.current = finalTranscript.trim()
  }, [finalTranscript])

  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop()
      }
      if (stopTimerRef.current) {
        window.clearTimeout(stopTimerRef.current)
      }
      stopSilenceDetection()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      closeStreamingClient()
      void SpeechRecognition.abortListening()
      stopAudioPlayback()
    }
  }, [])

  async function startListening() {
    if (capturePhase === 'processing') {
      notifyOnce(
        'stt-processing',
        'Robot dang nhan dang cau vua noi, vui long cho them mot chut.',
        'info',
      )
      return
    }

    if (listening) {
      stopListening()
      return
    }

    if (!captureSupported) {
      notifyOnce(
        'stt-unsupported',
        'Trinh duyet hien tai khong ho tro thu am on dinh de nhan giong noi.',
      )
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      streamRef.current = stream
      chunksRef.current = []
      speechStartedAtRef.current = null
      silenceStartedAtRef.current = null
      latestBrowserTranscriptRef.current = ''
      latestBrowserFinalTranscriptRef.current = ''
      latestStreamingPartialRef.current = ''
      lastStreamingFlushAtRef.current = 0
      partialTranscriptHandlerRef.current?.('')
      resetTranscript()
      initStreamingClient('speech.webm')

      const mimeType = pickRecorderMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      recorderRef.current = recorder

      recorder.ondataavailable = (event) => {
        if (event.data.size <= 0) {
          return
        }

        chunksRef.current.push(event.data)
        const streamingClient = streamingClientRef.current
        if (streamingClient) {
          streamingClient.sendChunk(event.data)
          const now = Date.now()
          if (now - lastStreamingFlushAtRef.current >= STREAMING_FLUSH_INTERVAL_MS) {
            streamingClient.flush()
            lastStreamingFlushAtRef.current = now
          }
        }
      }

      recorder.onerror = () => {
        notifyOnce('stt-recorder-error', 'Khong the thu am tu microphone luc nay.')
        void finalizeRecording()
      }

      recorder.onstop = () => {
        void finalizeRecording()
      }

      recorder.start(RECORDER_CHUNK_MS)
      startSilenceDetection(stream)
      setListening(true)
      setCapturePhase('listening')

      if (browserSupportsSpeechRecognition && isMicrophoneAvailable) {
        try {
          await SpeechRecognition.startListening({
            continuous: true,
            interimResults: true,
            language: lang,
          })
        } catch {
          // Keep backend streaming STT active even if browser STT fails.
        }
      }

      stopTimerRef.current = window.setTimeout(() => {
        stopListening()
      }, MAX_RECORDING_MS)
    } catch {
      notifyOnce(
        'stt-mic-permission',
        'Microphone chua duoc cap quyen hoac dang ban, vui long thu lai.',
      )
      setCapturePhase('idle')
      void finalizeRecording()
    }
  }

  function stopListening() {
    if (listening) {
      setCapturePhase('processing')
    }

    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    void SpeechRecognition.stopListening().catch(() => undefined)
  }

  async function speak(text: string) {
    if (!synthesisSupported) {
      throw new Error('Trinh duyet hien tai khong ho tro phat audio.')
    }

    stopAudioPlayback()
    const audioBlob = await synthesizeSpeech(text)
    const audioUrl = URL.createObjectURL(audioBlob)
    const audio = new Audio(audioUrl)
    audioRef.current = audio

    return new Promise<void>((resolve, reject) => {
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl)
        if (audioRef.current === audio) {
          audioRef.current = null
        }
        resolve()
      }
      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl)
        if (audioRef.current === audio) {
          audioRef.current = null
        }
        reject(new Error('Khong the phat audio tu backend.'))
      }
      void audio.play().catch(() => {
        URL.revokeObjectURL(audioUrl)
        if (audioRef.current === audio) {
          audioRef.current = null
        }
        reject(new Error('Trinh duyet chan phat audio tu dong.'))
      })
    })
  }

  async function finalizeRecording() {
    if (stopTimerRef.current) {
      window.clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }

    stopSilenceDetection()

    const stream = streamRef.current
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
    }

    const hasSpeechData =
      chunksRef.current.length > 0 ||
      Boolean(latestBrowserTranscriptRef.current) ||
      Boolean(latestBrowserFinalTranscriptRef.current) ||
      Boolean(latestStreamingPartialRef.current)

    setListening(false)
    setCapturePhase(hasSpeechData ? 'processing' : 'idle')

    const mimeType = chunksRef.current[0]?.type || pickRecorderMimeType() || 'audio/webm'
    const audioBlob = chunksRef.current.length > 0 ? new Blob(chunksRef.current, { type: mimeType }) : null
    chunksRef.current = []

    try {
      const streamingFinal = await requestStreamingFinal()
      let transcript = ''
      let fallbackMessage: string | null = null

      if (streamingFinal?.status === 'ok' && streamingFinal.transcript.trim()) {
        transcript = streamingFinal.transcript.trim()
      } else if (streamingFinal?.status === 'retry') {
        fallbackMessage = streamingFinal.message ?? 'Minh nghe chua ro, ban noi lai giup minh nhe.'
      } else if (streamingFinal?.status === 'error') {
        fallbackMessage = streamingFinal.message ?? 'Streaming STT dang gap loi tam thoi.'
      }

      const browserTranscript = await waitForBrowserTranscript()
      const shouldFallbackToBackend =
        !transcript &&
        (!browserTranscript || shouldIgnoreTranscript(browserTranscript, lastAcceptedTranscriptRef.current))

      if (
        !transcript &&
        browserTranscript &&
        !shouldIgnoreTranscript(browserTranscript, lastAcceptedTranscriptRef.current)
      ) {
        transcript = browserTranscript
      }

      if (!transcript && shouldFallbackToBackend && audioBlob) {
        const result = await transcribeSpeech(audioBlob)
        transcript = result.transcript.trim()
        if (result.status === 'retry' || !transcript) {
          fallbackMessage = result.message ?? 'Minh nghe chua ro, ban noi lai giup minh nhe.'
        }
      }

      partialTranscriptHandlerRef.current?.('')
      resetTranscript()
      latestBrowserTranscriptRef.current = ''
      latestBrowserFinalTranscriptRef.current = ''
      latestStreamingPartialRef.current = ''

      if (!transcript) {
        if (fallbackMessage) {
          noticeHandlerRef.current(fallbackMessage, 'info')
        }
        return
      }

      if (shouldIgnoreTranscript(transcript, lastAcceptedTranscriptRef.current)) {
        noticeHandlerRef.current('Minh vua bo qua mot am thanh nen khong giong yeu cau goi mon.', 'info')
        return
      }

      lastAcceptedTranscriptRef.current = {
        text: transcript,
        at: Date.now(),
      }
      transcriptHandlerRef.current(transcript)
    } catch (error) {
      const message =
        error instanceof Error
          ? `Backend speech-to-text loi: ${error.message}`
          : 'Backend speech-to-text dang gap loi.'
      notifyOnce('stt-backend-error', message)
    } finally {
      closeStreamingClient()
      setCapturePhase('idle')
    }
  }

  function initStreamingClient(filename: string) {
    closeStreamingClient()

    streamingFinalPromiseRef.current = new Promise<StreamingSpeechFinalEvent | null>((resolve) => {
      resolveStreamingFinalRef.current = resolve
    })

    const client = new StreamingSpeechClient(handleStreamingEvent, () => undefined)
    streamingClientRef.current = client
    streamingReadyPromiseRef.current = client
      .waitUntilOpen(STREAMING_READY_WAIT_MS)
      .then(() => {
        client.start(filename)
        return true
      })
      .catch(() => false)
  }

  function closeStreamingClient() {
    const resolver = resolveStreamingFinalRef.current
    if (resolver) {
      resolver(null)
    }
    resolveStreamingFinalRef.current = null
    streamingFinalPromiseRef.current = null
    streamingReadyPromiseRef.current = null
    latestStreamingPartialRef.current = ''

    if (streamingClientRef.current) {
      streamingClientRef.current.close()
      streamingClientRef.current = null
    }
  }

  function handleStreamingEvent(event: StreamingSpeechEvent) {
    if (event.type === 'partial') {
      const cleaned = event.transcript.trim()
      if (!cleaned || cleaned === latestStreamingPartialRef.current) {
        return
      }

      latestStreamingPartialRef.current = cleaned
      partialTranscriptHandlerRef.current?.(cleaned)
      return
    }

    const resolver = resolveStreamingFinalRef.current
    resolveStreamingFinalRef.current = null
    if (resolver) {
      resolver(event)
    }
  }

  async function requestStreamingFinal() {
    const streamingClient = streamingClientRef.current
    if (!streamingClient) {
      return null
    }

    const readyPromise = streamingReadyPromiseRef.current ?? Promise.resolve(false)
    const ready = await Promise.race([readyPromise, delay(STREAMING_READY_WAIT_MS).then(() => false)])
    if (!ready) {
      return null
    }

    streamingClient.flush()
    streamingClient.finalize()
    const finalPromise = streamingFinalPromiseRef.current
    if (!finalPromise) {
      return null
    }

    return (await Promise.race([
      finalPromise,
      delay(STREAMING_FINAL_WAIT_MS).then(() => null),
    ])) as StreamingSpeechFinalEvent | null
  }

  function startSilenceDetection(stream: MediaStream) {
    stopSilenceDetection()

    const AudioContextCtor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) {
      return
    }

    try {
      const audioContext = new AudioContextCtor()
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.2

      const mediaSource = audioContext.createMediaStreamSource(stream)
      mediaSource.connect(analyser)

      audioContextRef.current = audioContext
      analyserRef.current = analyser
      mediaSourceRef.current = mediaSource
      analysisBufferRef.current = new Uint8Array(analyser.fftSize)

      const tick = () => {
        const recorder = recorderRef.current
        const analyserNode = analyserRef.current
        const buffer = analysisBufferRef.current

        if (!recorder || recorder.state === 'inactive' || !analyserNode || !buffer) {
          silenceCheckFrameRef.current = null
          return
        }

        analyserNode.getByteTimeDomainData(buffer)
        const rms = calculateRms(buffer)
        const now = Date.now()

        if (rms >= SILENCE_RMS_THRESHOLD) {
          speechStartedAtRef.current ??= now
          silenceStartedAtRef.current = null
        } else if (speechStartedAtRef.current !== null) {
          if (silenceStartedAtRef.current === null) {
            silenceStartedAtRef.current = now
          } else if (
            now - speechStartedAtRef.current >= MIN_SPEECH_CAPTURE_MS &&
            now - silenceStartedAtRef.current >= SILENCE_STOP_MS
          ) {
            stopListening()
            silenceCheckFrameRef.current = null
            return
          }
        }

        silenceCheckFrameRef.current = window.requestAnimationFrame(tick)
      }

      silenceCheckFrameRef.current = window.requestAnimationFrame(tick)
    } catch {
      stopSilenceDetection()
    }
  }

  function stopSilenceDetection() {
    if (silenceCheckFrameRef.current) {
      window.cancelAnimationFrame(silenceCheckFrameRef.current)
      silenceCheckFrameRef.current = null
    }

    silenceStartedAtRef.current = null
    speechStartedAtRef.current = null
    analysisBufferRef.current = null

    if (mediaSourceRef.current) {
      mediaSourceRef.current.disconnect()
      mediaSourceRef.current = null
    }

    if (analyserRef.current) {
      analyserRef.current.disconnect()
      analyserRef.current = null
    }

    const audioContext = audioContextRef.current
    audioContextRef.current = null
    if (audioContext) {
      void audioContext.close().catch(() => undefined)
    }
  }

  async function waitForBrowserTranscript() {
    const startedAt = Date.now()
    while (Date.now() - startedAt < BROWSER_FINAL_WAIT_MS) {
      const transcriptCandidate = latestBrowserFinalTranscriptRef.current || latestBrowserTranscriptRef.current
      if (transcriptCandidate) {
        return transcriptCandidate.trim()
      }
      await delay(50)
    }

    return (latestBrowserFinalTranscriptRef.current || latestBrowserTranscriptRef.current).trim()
  }

  function stopAudioPlayback() {
    if (!audioRef.current) {
      return
    }

    const currentAudio = audioRef.current
    audioRef.current = null
    currentAudio.pause()
    currentAudio.currentTime = 0
  }

  return {
    listening,
    capturePhase,
    recognitionSupported,
    synthesisSupported,
    startListening,
    stopListening,
    speak,
  }

  function notifyOnce(key: string, message: string, level: 'warning' | 'info' = 'warning') {
    if (notifiedKeysRef.current.has(key)) {
      return
    }
    notifiedKeysRef.current.add(key)
    noticeHandlerRef.current(message, level)
  }
}

function pickRecorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? ''
}

function shouldIgnoreTranscript(
  transcript: string,
  lastAccepted: { text: string; at: number } | null,
) {
  const normalized = normalizeTranscript(transcript)
  if (!normalized) {
    return true
  }

  if (AMBIENT_WATERMARK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true
  }

  if (
    lastAccepted &&
    normalized === normalizeTranscript(lastAccepted.text) &&
    Date.now() - lastAccepted.at < REPEATED_TRANSCRIPT_WINDOW_MS
  ) {
    return true
  }

  return false
}

function normalizeTranscript(text: string) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function calculateRms(buffer: Uint8Array<ArrayBuffer>) {
  let sum = 0
  for (const value of buffer) {
    const normalized = (value - 128) / 128
    sum += normalized * normalized
  }
  return Math.sqrt(sum / buffer.length)
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
