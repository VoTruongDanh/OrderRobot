import { useEffect, useRef } from 'react'
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition'
import { synthesizeSpeech, synthesizeSpeechStream } from '../api'

// onPartialTranscript removed — caller reads interimTranscript directly from return value
type UseSpeechOptions = {
  lang: string
  onTranscript: (transcript: string) => void
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

// How long speech must be silent before we fire onTranscript.
// Shorter = more responsive but may cut off slow speakers.
const SUBMIT_SILENCE_MS = 600

export function useSpeech({ lang, onTranscript, onNotice }: UseSpeechOptions) {
  const transcriptHandlerRef = useRef(onTranscript)
  const noticeHandlerRef = useRef(onNotice)
  const notifiedKeysRef = useRef<Set<string>>(new Set())
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lastAcceptedTranscriptRef = useRef<{ text: string; at: number } | null>(null)

  // === Pipeline B state ===
  // These refs manage the "process after silence" gate.
  // They are intentionally NOT React state — updates here must not trigger re-renders.
  const submitTimerRef = useRef<number | null>(null)
  const pendingSubmitTextRef = useRef('')
  const accumulatedFinalRef = useRef('')
  const lastInterimTextRef = useRef('')
  const interimSubmitTimerRef = useRef<number | null>(null)

  const {
    interimTranscript,
    finalTranscript,
    listening,
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
    noticeHandlerRef.current = onNotice
  }, [onNotice, onTranscript])

  useEffect(() => {
    return () => {
      void SpeechRecognition.abortListening()
      stopAudioPlayback()
      clearSubmitTimer()
      clearInterimSubmitTimer()
    }
  }, [])

  // === Pipeline A: display ===
  // interimTranscript is returned directly from this hook (see return statement).
  // There is NO effect here for display — the value flows straight out.
  // React's own diffing handles re-renders only when it actually changes.

  // === Pipeline B: process ===
  // Part 1 — new final text arrives → schedule a submit after silence
  useEffect(() => {
    const committed = finalTranscript.trim()
    if (!committed) return

    // Extract only new content since the last time we scheduled a submit
    const newPart = committed.startsWith(accumulatedFinalRef.current)
      ? committed.slice(accumulatedFinalRef.current.length).trim()
      : committed

    if (!newPart) return

    accumulatedFinalRef.current = committed
    pendingSubmitTextRef.current = newPart

    // Reset the gate — user may still be speaking
    clearSubmitTimer()
    submitTimerRef.current = window.setTimeout(() => {
      submitTimerRef.current = null
      const text = pendingSubmitTextRef.current
      pendingSubmitTextRef.current = ''

      if (!text) return

      if (shouldIgnoreTranscript(text, lastAcceptedTranscriptRef.current)) {
        noticeHandlerRef.current(
          'Mình vừa bỏ qua âm thanh nền, không giống yêu cầu gọi món.',
          'info',
        )
        return
      }

      lastAcceptedTranscriptRef.current = { text, at: Date.now() }
      transcriptHandlerRef.current(text)
    }, SUBMIT_SILENCE_MS)
  }, [finalTranscript])

  // Part 2 — user is still speaking → cancel the pending submit
  useEffect(() => {
    if (interimTranscript.trim() && submitTimerRef.current !== null) {
      clearSubmitTimer()
    }
  }, [interimTranscript])

  // Part 3 — Fallback: if interimTranscript stops changing, submit it
  // This handles browsers that don't emit finalTranscript in continuous mode
  useEffect(() => {
    const trimmed = interimTranscript.trim()
    
    // Clear any existing interim timer
    clearInterimSubmitTimer()
    
    if (!trimmed || !listening) {
      lastInterimTextRef.current = ''
      return
    }
    
    // If interim text changed, reset the timer
    if (trimmed !== lastInterimTextRef.current) {
      lastInterimTextRef.current = trimmed
      
      // Start a timer to submit if text stops changing
      interimSubmitTimerRef.current = window.setTimeout(() => {
        const textToSubmit = lastInterimTextRef.current
        
        if (!textToSubmit) return
        
        if (shouldIgnoreTranscript(textToSubmit, lastAcceptedTranscriptRef.current)) {
          noticeHandlerRef.current(
            'Mình vừa bỏ qua âm thanh nền, không giống yêu cầu gọi món.',
            'info',
          )
          return
        }
        
        lastAcceptedTranscriptRef.current = { text: textToSubmit, at: Date.now() }
        lastInterimTextRef.current = ''
        transcriptHandlerRef.current(textToSubmit)
      }, SUBMIT_SILENCE_MS)
    }
  }, [interimTranscript, listening])

  // Clean up gate when listening stops externally (e.g. robot starts speaking)
  useEffect(() => {
    if (!listening) {
      clearSubmitTimer()
      clearInterimSubmitTimer()
      lastInterimTextRef.current = ''
    }
  }, [listening])

  function clearSubmitTimer() {
    if (submitTimerRef.current !== null) {
      window.clearTimeout(submitTimerRef.current)
      submitTimerRef.current = null
    }
  }

  function clearInterimSubmitTimer() {
    if (interimSubmitTimerRef.current !== null) {
      window.clearTimeout(interimSubmitTimerRef.current)
      interimSubmitTimerRef.current = null
    }
  }

  async function startListening() {
    if (!browserSupportsSpeechRecognition) {
      const error = new Error('Browser không hỗ trợ nhận giọng nói')
      notifyOnce(
        'stt-unsupported',
        'Trình duyệt không hỗ trợ nhận giọng nói. Dùng Chrome hoặc Edge mới nhé.',
      )
      throw error
    }

    if (!isMicrophoneAvailable) {
      const error = new Error('Microphone không khả dụng')
      notifyOnce(
        'stt-mic-permission',
        'Microphone chưa được cấp quyền hoặc đang bận.',
      )
      throw error
    }

    stopAudioPlayback()

    // Reset Pipeline B state for clean turn
    clearSubmitTimer()
    clearInterimSubmitTimer()
    pendingSubmitTextRef.current = ''
    accumulatedFinalRef.current = ''
    lastInterimTextRef.current = ''
    resetTranscript()

    try {
      await SpeechRecognition.startListening({
        continuous: true,
        interimResults: true,
        language: lang,
      })
      console.log('[useSpeech] Successfully started listening')
    } catch (error) {
      console.error('[useSpeech] Failed to start listening:', error)
      notifyOnce('stt-start-error', 'Không thể bật nhận giọng nói từ trình duyệt lúc này.')
      throw error
    }
  }

  function stopListening() {
    clearSubmitTimer()
    void SpeechRecognition.stopListening()
  }

  async function speak(text: string) {
    if (!synthesisSupported) {
      throw new Error('Trình duyệt hiện tại không hỗ trợ phát audio.')
    }

    stopAudioPlayback()

    try {
      const stream = await synthesizeSpeechStream(text)
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) chunks.push(value)
      }

      if (chunks.length === 0) throw new Error('Không nhận được audio từ backend.')

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
      const combined = new Uint8Array(totalLength)
      let offset = 0
      for (const c of chunks) { combined.set(c, offset); offset += c.length }

      return playAudioBlob(new Blob([combined], { type: 'audio/mpeg' }))
    } catch {
      const audioBlob = await synthesizeSpeech(text)
      return playAudioBlob(audioBlob)
    }
  }

  function playAudioBlob(blob: Blob): Promise<void> {
    const audioUrl = URL.createObjectURL(blob)
    const audio = new Audio(audioUrl)
    audioRef.current = audio

    return new Promise<void>((resolve, reject) => {
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl)
        if (audioRef.current === audio) audioRef.current = null
        resolve()
      }
      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl)
        if (audioRef.current === audio) audioRef.current = null
        reject(new Error('Không thể phát audio từ backend.'))
      }
      void audio.play().catch(() => {
        URL.revokeObjectURL(audioUrl)
        if (audioRef.current === audio) audioRef.current = null
        reject(new Error('Trình duyệt chặn phát audio tự động.'))
      })
    })
  }

  function stopAudioPlayback() {
    if (!audioRef.current) return
    const a = audioRef.current
    audioRef.current = null
    a.pause()
    a.currentTime = 0
  }

  function notifyOnce(key: string, message: string, level: 'warning' | 'info' = 'warning') {
    if (notifiedKeysRef.current.has(key)) return
    notifiedKeysRef.current.add(key)
    noticeHandlerRef.current(message, level)
  }

  return {
    // Pipeline A — live caption, direct passthrough, zero overhead
    interimTranscript,
    // Core state
    listening,
    recognitionSupported,
    synthesisSupported,
    // Controls
    startListening,
    stopListening,
    speak,
  }
}

function shouldIgnoreTranscript(
  transcript: string,
  lastAccepted: { text: string; at: number } | null,
) {
  const normalized = normalizeTranscript(transcript)
  if (!normalized) return true

  if (AMBIENT_WATERMARK_PATTERNS.some((p) => p.test(normalized))) return true

  if (
    lastAccepted &&
    normalized === normalizeTranscript(lastAccepted.text) &&
    Date.now() - lastAccepted.at < REPEATED_TRANSCRIPT_WINDOW_MS
  ) return true

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
