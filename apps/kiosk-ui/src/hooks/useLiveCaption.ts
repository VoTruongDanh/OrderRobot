import { useEffect, useRef, useState } from 'react'

import {
  type StreamingSpeechEvent,
  type StreamingSpeechFinalEvent,
  StreamingSpeechClient,
} from '../api'
import { getMicAudioConstraints } from '../config'

type UseLiveCaptionOptions = {
  lang: string
}

type LiveCaptionEngine = 'native' | 'backend'

export type LiveCaptionStatus =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'stopping'
  | 'unsupported'
  | 'error'

const RESTART_DELAY_MS = 180
const RECORDER_CHUNK_MS = 180
const STREAMING_READY_WAIT_MS = 1400
const STREAMING_FINAL_WAIT_MS = 3200
const STREAMING_FLUSH_INTERVAL_MS = 220

export function useLiveCaption({ lang }: UseLiveCaptionOptions) {
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const shouldRestartRef = useRef(false)
  const restartTimerRef = useRef<number | null>(null)
  const stopReasonRef = useRef<'user' | 'fatal-error' | null>(null)
  const fallbackInFlightRef = useRef(false)
  const committedFinalTranscriptRef = useRef('')
  const currentSessionFinalTranscriptRef = useRef('')
  const activeEngineRef = useRef<LiveCaptionEngine | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const streamingClientRef = useRef<StreamingSpeechClient | null>(null)
  const streamingReadyPromiseRef = useRef<Promise<boolean> | null>(null)
  const streamingFinalPromiseRef = useRef<Promise<StreamingSpeechFinalEvent | null> | null>(null)
  const resolveStreamingFinalRef = useRef<((value: StreamingSpeechFinalEvent | null) => void) | null>(null)
  const lastStreamingFlushAtRef = useRef(0)
  const [status, setStatus] = useState<LiveCaptionStatus>('idle')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [finalTranscript, setFinalTranscript] = useState('')
  const [error, setError] = useState('')
  const [engine, setEngine] = useState<LiveCaptionEngine | null>(null)

  const supported =
    typeof window !== 'undefined' &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
  const backendSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)

  useEffect(() => {
    return () => {
      shouldRestartRef.current = false
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current)
        restartTimerRef.current = null
      }
      resetRecognition(true)
      teardownBackendCapture()
    }
  }, [])

  useEffect(() => {
    if (recognitionRef.current) {
      recognitionRef.current.lang = lang
    }
  }, [lang])

  async function start() {
    if (!supported && !backendSupported) {
      setStatus('unsupported')
      setError('Browser nay khong ho tro live caption native hoac backend audio capture on dinh.')
      return
    }

    if (status === 'starting' || status === 'listening') {
      return
    }

    setError('')
    setStatus('starting')
    shouldRestartRef.current = true
    stopReasonRef.current = null

    try {
      await ensureMicrophoneAccess()
    } catch (error) {
      shouldRestartRef.current = false
      stopReasonRef.current = 'fatal-error'
      setStatus('error')
      setError(error instanceof Error ? error.message : 'Khong the truy cap microphone.')
      return
    }

    if (backendSupported) {
      await startBackendCaption()
      return
    }

    if (supported) {
      const started = await startNativeRecognition()
      if (started) {
        return
      }
    }

    setStatus('error')
    setError('Khong the bat STT live caption tren browser nay.')
  }

  function stop() {
    shouldRestartRef.current = false
    stopReasonRef.current = 'user'
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current)
      restartTimerRef.current = null
    }

    if (activeEngineRef.current === 'backend') {
      const recorder = recorderRef.current
      if (!recorder || recorder.state === 'inactive') {
        teardownBackendCapture()
        setStatus('idle')
        setEngine(null)
        return
      }

      setStatus('stopping')
      recorder.stop()
      return
    }

    const recognition = recognitionRef.current
    if (!recognition) {
      setStatus('idle')
      setEngine(null)
      return
    }

    setStatus('stopping')
    try {
      recognition.stop()
    } catch {
      resetRecognition(true)
      setStatus('idle')
      setEngine(null)
    }
  }

  function clear() {
    committedFinalTranscriptRef.current = ''
    currentSessionFinalTranscriptRef.current = ''
    setInterimTranscript('')
    setFinalTranscript('')
    setError('')
    if (status === 'error') {
      setStatus('idle')
    }
  }

  return {
    supported,
    backendSupported,
    status,
    interimTranscript,
    finalTranscript,
    error,
    engine,
    start,
    stop,
    clear,
    isListening: status === 'starting' || status === 'listening',
  }

  async function startNativeRecognition() {
    const recognition = ensureRecognition(lang, {
      onStart: () => {
        activeEngineRef.current = 'native'
        setEngine('native')
        setStatus('listening')
        setError('')
      },
      onResult: ({ finalText, interimText }) => {
        currentSessionFinalTranscriptRef.current = finalText
        setFinalTranscript(joinCaptionText(committedFinalTranscriptRef.current, finalText))
        setInterimTranscript(interimText)
      },
      onError: (event) => {
        if (event.error === 'aborted') {
          return
        }

        if (event.error === 'no-speech') {
          setInterimTranscript('')
          return
        }

        if (canFallbackToBackend(event.error)) {
          void fallbackToBackend(getSpeechRecognitionErrorMessage(event))
          return
        }

        shouldRestartRef.current = false
        stopReasonRef.current = 'fatal-error'
        setError(getSpeechRecognitionErrorMessage(event))
        setStatus('error')
      },
      onEnd: () => {
        commitCurrentSessionFinal()

        if (!shouldRestartRef.current) {
          resetRecognition(false)
          setInterimTranscript('')
          activeEngineRef.current = null
          setEngine(null)
          if (stopReasonRef.current === 'user') {
            setStatus('idle')
          } else if (stopReasonRef.current === 'fatal-error') {
            setStatus('error')
          } else {
            setStatus('idle')
          }
          stopReasonRef.current = null
          return
        }

        if (restartTimerRef.current !== null) {
          window.clearTimeout(restartTimerRef.current)
        }
        restartTimerRef.current = window.setTimeout(() => {
          restartTimerRef.current = null
          if (!shouldRestartRef.current || !recognitionRef.current) {
            return
          }
          try {
            recognitionRef.current.start()
          } catch {
            void fallbackToBackend('Khong the khoi dong lai native live caption.')
          }
        }, RESTART_DELAY_MS)
      },
    })

    try {
      recognition.start()
      return true
    } catch {
      resetRecognition(true)
      return false
    }
  }

  async function fallbackToBackend(reason: string) {
    if (fallbackInFlightRef.current || !backendSupported) {
      shouldRestartRef.current = false
      stopReasonRef.current = 'fatal-error'
      setStatus('error')
      setError(reason)
      return
    }

    fallbackInFlightRef.current = true
    shouldRestartRef.current = false
    stopReasonRef.current = null
    resetRecognition(true)
    setStatus('starting')
    setError(`${reason} Dang chuyen sang backend streaming live caption...`)

    try {
      await startBackendCaption(reason)
    } finally {
      fallbackInFlightRef.current = false
    }
  }

  async function startBackendCaption(reason?: string) {
    if (!backendSupported) {
      shouldRestartRef.current = false
      stopReasonRef.current = 'fatal-error'
      setStatus('error')
      setError(reason || 'Browser nay khong ho tro backend live caption capture.')
      return
    }

    teardownBackendCapture()

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: getMicAudioConstraints(),
      })
      streamRef.current = stream

      initStreamingClient('speech.webm')
      const readyPromise = streamingReadyPromiseRef.current ?? Promise.resolve(false)
      const ready = await Promise.race([readyPromise, delay(STREAMING_READY_WAIT_MS).then(() => false)])
      if (!ready) {
        throw new Error('Khong the mo ket noi backend streaming STT.')
      }

      const mimeType = pickRecorderMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size <= 0) {
          return
        }

        const client = streamingClientRef.current
        if (!client) {
          return
        }

        client.sendChunk(event.data)
        const now = Date.now()
        if (now - lastStreamingFlushAtRef.current >= STREAMING_FLUSH_INTERVAL_MS) {
          client.flush()
          lastStreamingFlushAtRef.current = now
        }
      }
      recorder.onerror = () => {
        shouldRestartRef.current = false
        stopReasonRef.current = 'fatal-error'
        void finalizeBackendCaption('Khong the thu am live caption tu microphone.')
      }
      recorder.onstop = () => {
        void finalizeBackendCaption()
      }
      recorder.start(RECORDER_CHUNK_MS)

      activeEngineRef.current = 'backend'
      setEngine('backend')
      setStatus('listening')
      setError('')
      setInterimTranscript('')
    } catch (error) {
      teardownBackendCapture()
      shouldRestartRef.current = false
      stopReasonRef.current = 'fatal-error'
      setStatus('error')
      setEngine(null)
      setError(
        error instanceof Error
          ? error.message
          : 'Khong the bat backend streaming live caption.',
      )
    }
  }

  async function finalizeBackendCaption(forcedError?: string) {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onerror = null
      recorder.onstop = null
    }

    const stream = streamRef.current
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    let resolvedError = forcedError ?? ''

    try {
      if (!forcedError) {
        const finalEvent = await requestStreamingFinal()
        const transcript =
          finalEvent?.status === 'ok' && finalEvent.transcript.trim()
            ? finalEvent.transcript.trim()
            : interimTranscript.trim()

        if (transcript) {
          committedFinalTranscriptRef.current = joinCaptionText(
            committedFinalTranscriptRef.current,
            transcript,
          )
          setFinalTranscript(committedFinalTranscriptRef.current)
        }

        if (finalEvent?.status === 'retry') {
          resolvedError = finalEvent.message ?? ''
        } else if (finalEvent?.status === 'error') {
          resolvedError = finalEvent.message ?? 'Backend live caption dang gap loi tam thoi.'
        }
      }
    } finally {
      closeStreamingClient()
      setInterimTranscript('')
      activeEngineRef.current = null
      setEngine(null)
      if (stopReasonRef.current === 'fatal-error') {
        setStatus('error')
      } else {
        setStatus('idle')
      }
      if (resolvedError) {
        setError(resolvedError)
      } else if (stopReasonRef.current === 'user') {
        setError('')
      }
      stopReasonRef.current = null
    }
  }

  function ensureRecognition(
    speechLang: string,
    handlers: {
      onStart: () => void
      onResult: (payload: { finalText: string; interimText: string }) => void
      onError: (event: SpeechRecognitionErrorEvent) => void
      onEnd: () => void
    },
  ) {
    if (recognitionRef.current) {
      recognitionRef.current.lang = speechLang
      return recognitionRef.current
    }

    const RecognitionCtor = window.SpeechRecognition ?? window.webkitSpeechRecognition
    const recognition = new RecognitionCtor()
    recognition.lang = speechLang
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.onstart = handlers.onStart
    recognition.onerror = handlers.onError
    recognition.onend = handlers.onEnd
    recognition.onresult = (event) => {
      let nextFinal = ''
      let nextInterim = ''

      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]
        const transcript = result[0]?.transcript?.trim() ?? ''
        if (!transcript) {
          continue
        }

        if (result.isFinal) {
          nextFinal = `${nextFinal} ${transcript}`.trim()
        } else {
          nextInterim = `${nextInterim} ${transcript}`.trim()
        }
      }

      handlers.onResult({ finalText: nextFinal, interimText: nextInterim })
    }

    recognitionRef.current = recognition
    return recognition
  }

  async function ensureMicrophoneAccess() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Trinh duyet nay khong ho tro truy cap microphone cho live caption.')
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: getMicAudioConstraints(),
      })
      stream.getTracks().forEach((track) => track.stop())
    } catch {
      throw new Error(
        'Live caption can quyen microphone. Hay cho phep mic trong trinh duyet va he dieu hanh roi thu lai.',
      )
    }
  }

  function resetRecognition(abort: boolean) {
    const recognition = recognitionRef.current
    if (!recognition) {
      return
    }

    recognition.onstart = null
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
    if (abort) {
      try {
        recognition.abort()
      } catch {
        // Ignore cleanup failures during teardown.
      }
    }
    recognitionRef.current = null
  }

  function commitCurrentSessionFinal() {
    if (!currentSessionFinalTranscriptRef.current) {
      return
    }

    committedFinalTranscriptRef.current = joinCaptionText(
      committedFinalTranscriptRef.current,
      currentSessionFinalTranscriptRef.current,
    )
    currentSessionFinalTranscriptRef.current = ''
    setFinalTranscript(committedFinalTranscriptRef.current)
  }

  function initStreamingClient(filename: string) {
    closeStreamingClient()
    lastStreamingFlushAtRef.current = 0

    streamingFinalPromiseRef.current = new Promise<StreamingSpeechFinalEvent | null>((resolve) => {
      resolveStreamingFinalRef.current = resolve
    })

    const client = new StreamingSpeechClient(handleStreamingEvent, (streamError) => {
      shouldRestartRef.current = false
      stopReasonRef.current = 'fatal-error'
      setStatus('error')
      setError(streamError.message)
    })

    streamingClientRef.current = client
    streamingReadyPromiseRef.current = client
      .waitUntilOpen(STREAMING_READY_WAIT_MS)
      .then(() => {
        client.start(filename, 'caption')
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

    if (streamingClientRef.current) {
      streamingClientRef.current.close()
      streamingClientRef.current = null
    }
  }

  async function requestStreamingFinal() {
    const streamingClient = streamingClientRef.current
    if (!streamingClient) {
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

  function handleStreamingEvent(event: StreamingSpeechEvent) {
    if (event.type === 'partial') {
      const transcript = event.transcript.trim()
      currentSessionFinalTranscriptRef.current = transcript
      setInterimTranscript(transcript)
      setFinalTranscript(joinCaptionText(committedFinalTranscriptRef.current, transcript))
      return
    }

    const resolver = resolveStreamingFinalRef.current
    resolveStreamingFinalRef.current = null
    if (resolver) {
      resolver(event)
    }
  }

  function teardownBackendCapture() {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onerror = null
      recorder.onstop = null
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // Ignore teardown stop failures.
        }
      }
    }

    const stream = streamRef.current
    streamRef.current = null
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
    }

    closeStreamingClient()
  }
}

function canFallbackToBackend(errorCode: string) {
  return ['audio-capture', 'language-not-supported', 'network', 'service-not-allowed'].includes(
    errorCode,
  )
}

function joinCaptionText(existingText: string, nextText: string) {
  return [existingText.trim(), nextText.trim()].filter(Boolean).join(' ').trim()
}

function getSpeechRecognitionErrorMessage(event: SpeechRecognitionErrorEvent) {
  switch (event.error) {
    case 'audio-capture':
      return 'Browser khong lay duoc audio tu microphone. Hay kiem tra mic co dang bi ung dung khac chiem dung khong.'
    case 'language-not-supported':
      return 'Trinh duyet hien tai khong ho tro ngon ngu nhan dien dang chon cho live caption.'
    case 'network':
      return 'Browser SpeechRecognition dang bi loi mang hoac speech service cua trinh duyet khong san sang.'
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Trinh duyet dang chan live caption speech service. Hay mo quyen microphone/site permission roi thu lai.'
    default:
      return event.message || `Speech recognition error: ${event.error}`
  }
}

function pickRecorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? ''
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
