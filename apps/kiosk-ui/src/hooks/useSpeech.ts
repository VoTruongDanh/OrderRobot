import { useEffect, useRef } from 'react'
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition'

import { synthesizeSpeech } from '../api'

type UseSpeechOptions = {
  lang: string
  onTranscript: (transcript: string) => void
  onPartialTranscript?: (transcript: string) => void
  onNotice: (message: string, level?: 'warning' | 'info') => void
}

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
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lastAcceptedTranscriptRef = useRef<{ text: string; at: number } | null>(null)
  const lastDispatchedFinalRef = useRef('')

  const {
    transcript,
    listening,
    finalTranscript,
    resetTranscript,
    browserSupportsSpeechRecognition,
    isMicrophoneAvailable,
  } = useSpeechRecognition({
    clearTranscriptOnListen: true,
  })

  const recognitionSupported =
    typeof window !== 'undefined' && browserSupportsSpeechRecognition && isMicrophoneAvailable
  const synthesisSupported = typeof window !== 'undefined' && typeof Audio !== 'undefined'

  useEffect(() => {
    transcriptHandlerRef.current = onTranscript
    partialTranscriptHandlerRef.current = onPartialTranscript
    noticeHandlerRef.current = onNotice
  }, [onNotice, onPartialTranscript, onTranscript])

  useEffect(() => {
    return () => {
      void SpeechRecognition.abortListening()
      stopAudioPlayback()
    }
  }, [])

  useEffect(() => {
    const liveTranscript = transcript.trim()
    if (!listening || !liveTranscript) {
      return
    }

    if (liveTranscript === lastDispatchedFinalRef.current) {
      return
    }

    partialTranscriptHandlerRef.current?.(liveTranscript)
  }, [listening, transcript])

  useEffect(() => {
    const transcript = finalTranscript.trim()
    if (!transcript || transcript === lastDispatchedFinalRef.current) {
      return
    }

    lastDispatchedFinalRef.current = transcript
    resetTranscript()

    if (shouldIgnoreTranscript(transcript, lastAcceptedTranscriptRef.current)) {
      noticeHandlerRef.current('Mình vừa bỏ qua một âm thanh nền không giống yêu cầu gọi món.', 'info')
      return
    }

    lastAcceptedTranscriptRef.current = {
      text: transcript,
      at: Date.now(),
    }
    transcriptHandlerRef.current(transcript)
  }, [finalTranscript, resetTranscript])

  async function startListening() {
    if (!browserSupportsSpeechRecognition) {
      notifyOnce(
        'stt-unsupported',
        'Trình duyệt hiện tại không hỗ trợ nhận giọng nói trực tiếp. Vui lòng dùng Chrome hoặc Edge mới.',
      )
      return
    }

    if (!isMicrophoneAvailable) {
      notifyOnce(
        'stt-mic-permission',
        'Microphone chưa được cấp quyền hoặc đang bận, vui lòng kiểm tra rồi thử lại.',
      )
      return
    }

    lastDispatchedFinalRef.current = ''
    resetTranscript()

    try {
      await SpeechRecognition.startListening({
        continuous: false,
        interimResults: true,
        language: lang,
      })
    } catch {
      notifyOnce('stt-start-error', 'Không thể bật nhận giọng nói từ trình duyệt lúc này.')
    }
  }

  function stopListening() {
    void SpeechRecognition.stopListening()
  }

  async function speak(text: string) {
    if (!synthesisSupported) {
      throw new Error('Trình duyệt hiện tại không hỗ trợ phát audio.')
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
        reject(new Error('Không thể phát audio từ backend.'))
      }
      void audio.play().catch(() => {
        URL.revokeObjectURL(audioUrl)
        if (audioRef.current === audio) {
          audioRef.current = null
        }
        reject(new Error('Trình duyệt chặn phát audio tự động.'))
      })
    })
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
