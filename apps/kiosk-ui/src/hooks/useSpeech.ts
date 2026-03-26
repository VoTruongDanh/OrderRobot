import { useEffect, useRef } from 'react'
import SpeechRecognition, { useSpeechRecognition } from 'react-speech-recognition'
import { synthesizeSpeech, synthesizeSpeechStream } from '../api'

// onPartialTranscript removed — caller reads interimTranscript directly from return value
type UseSpeechOptions = {
  lang: string
  onTranscript: (transcript: string) => void
  onNotice: (message: string, level?: 'warning' | 'info') => void
  onBargeIn?: () => void  // called when user interrupts bot mid-speech
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
const SUBMIT_SILENCE_MS = 1200

// How long to keep the echo gate closed after bot audio ends.
// This catches residual mic echo from speaker output.
const ECHO_COOLDOWN_MS = 300

// Minimum interim transcript length to consider as real user speech (barge-in)
const BARGE_IN_MIN_CHARS = 3
const LISTENING_STALL_RECOVERY_MS = 12000
const LISTENING_STALL_POLL_MS = 1500

export function useSpeech({ lang, onTranscript, onNotice, onBargeIn }: UseSpeechOptions) {
  const transcriptHandlerRef = useRef(onTranscript)
  const noticeHandlerRef = useRef(onNotice)
  const bargeInHandlerRef = useRef(onBargeIn)
  const notifiedKeysRef = useRef<Set<string>>(new Set())
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioCleanupRef = useRef<(() => void) | null>(null)
  const lastAcceptedTranscriptRef = useRef<{ text: string; at: number } | null>(null)

  // === Echo cancellation state ===
  // When bot is speaking, we gate all incoming transcripts to avoid
  // the microphone picking up the speaker output as user input.
  const isSpeakingRef = useRef(false)
  const echoCooldownTimerRef = useRef<number | null>(null)
  const echoGateOpenRef = useRef(true)  // false = gate closed, reject transcripts
  const listeningStartedAtRef = useRef(0)
  const lastSpeechActivityAtRef = useRef(0)
  const listeningRecoveryUsedRef = useRef(false)
  const recoveryInFlightRef = useRef(false)

  // === Pipeline B state ===
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
    bargeInHandlerRef.current = onBargeIn
  }, [onNotice, onTranscript, onBargeIn])

  useEffect(() => {
    return () => {
      void SpeechRecognition.abortListening()
      stopAudioPlayback()
      clearSubmitTimer()
      clearInterimSubmitTimer()
      clearEchoCooldown()
    }
  }, [])

  useEffect(() => {
    if (interimTranscript.trim() || finalTranscript.trim()) {
      lastSpeechActivityAtRef.current = Date.now()
    }
  }, [finalTranscript, interimTranscript])

  // === Pipeline A: display ===
  // interimTranscript is returned directly from this hook (see return statement).
  // There is NO effect here for display — the value flows straight out.
  // React's own diffing handles re-renders only when it actually changes.

  // === Pipeline B: process ===
  // Part 1 — new final text arrives → schedule a submit after silence
  useEffect(() => {
    const committed = finalTranscript.trim()
    if (!committed) return

    // === Echo gate: reject transcripts while bot is speaking ===
    if (!echoGateOpenRef.current) {
      console.log('[useSpeech] Echo gate CLOSED — dropping final transcript:', committed.slice(0, 40))
      return
    }

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

    // === Barge-in detection ===
    // If bot is speaking and user says something substantial, interrupt the bot
    if (isSpeakingRef.current && trimmed.length >= BARGE_IN_MIN_CHARS) {
      console.log('[useSpeech] BARGE-IN detected:', trimmed.slice(0, 30))
      stopAudioPlayback()
      openEchoGate()  // user is talking — open the gate
      bargeInHandlerRef.current?.()
    }

    // Don't process if echo gate is closed
    if (!echoGateOpenRef.current) return
    
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
      listeningStartedAtRef.current = 0
      recoveryInFlightRef.current = false
    }
  }, [listening])

  useEffect(() => {
    if (!listening || !recognitionSupported) {
      return
    }

    const timer = window.setInterval(() => {
      if (recoveryInFlightRef.current) {
        return
      }
      if (listeningRecoveryUsedRef.current) {
        return
      }
      if (isSpeakingRef.current || !echoGateOpenRef.current) {
        return
      }

      const now = Date.now()
      const startedAt = listeningStartedAtRef.current || now
      const lastSpeechAt = lastSpeechActivityAtRef.current || startedAt

      if (now - startedAt < LISTENING_STALL_RECOVERY_MS) {
        return
      }
      if (now - lastSpeechAt < LISTENING_STALL_RECOVERY_MS) {
        return
      }

      recoveryInFlightRef.current = true
      listeningRecoveryUsedRef.current = true

      void (async () => {
        try {
          console.warn('[useSpeech] Listening stall detected, auto-restarting speech recognition')
          noticeHandlerRef.current(
            'Microphone dang dong bo lai vi tam thoi khong nghe duoc. Ban thu noi lai giup minh nhe.',
            'info',
          )
          await SpeechRecognition.abortListening()
          await new Promise((resolve) => setTimeout(resolve, 200))
          await SpeechRecognition.startListening({
            continuous: true,
            interimResults: true,
            language: lang,
          })
          const recoveredAt = Date.now()
          listeningStartedAtRef.current = recoveredAt
          lastSpeechActivityAtRef.current = recoveredAt
        } catch (error) {
          console.error('[useSpeech] Auto-restart listening failed:', error)
          notifyOnce('stt-stall-recover-failed', 'Khong the khoi dong lai microphone tu dong. Hay bam Lai nghe.')
        } finally {
          recoveryInFlightRef.current = false
        }
      })()
    }, LISTENING_STALL_POLL_MS)

    return () => {
      window.clearInterval(timer)
    }
  }, [lang, listening, recognitionSupported])

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

  function clearEchoCooldown() {
    if (echoCooldownTimerRef.current !== null) {
      window.clearTimeout(echoCooldownTimerRef.current)
      echoCooldownTimerRef.current = null
    }
  }

  function closeEchoGate() {
    echoGateOpenRef.current = false
    isSpeakingRef.current = true
    clearEchoCooldown()
  }

  function openEchoGate() {
    isSpeakingRef.current = false
    // Delay opening the gate to catch residual speaker echo
    clearEchoCooldown()
    echoCooldownTimerRef.current = window.setTimeout(() => {
      echoGateOpenRef.current = true
      echoCooldownTimerRef.current = null
      console.log('[useSpeech] Echo gate OPENED after cooldown')
    }, ECHO_COOLDOWN_MS)
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

    // Don't stop playback here — allow barge-in scenario
    // stopAudioPlayback() is now only called on explicit user action or barge-in

    // Reset Pipeline B state for clean turn
    clearSubmitTimer()
    clearInterimSubmitTimer()
    clearEchoCooldown()
    isSpeakingRef.current = false
    echoGateOpenRef.current = true
    pendingSubmitTextRef.current = ''
    accumulatedFinalRef.current = ''
    lastInterimTextRef.current = ''
    listeningRecoveryUsedRef.current = false
    const startedAt = Date.now()
    listeningStartedAtRef.current = startedAt
    lastSpeechActivityAtRef.current = startedAt
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
    audio.preload = 'auto'
    audioRef.current = audio
    audioCleanupRef.current = () => {
      URL.revokeObjectURL(audioUrl)
    }
    closeEchoGate()  // prevent mic from hearing speaker output

    return new Promise<void>((resolve, reject) => {
      audio.onended = () => {
        audioCleanupRef.current?.()
        audioCleanupRef.current = null
        if (audioRef.current === audio) audioRef.current = null
        openEchoGate()  // re-open gate after speech ends (with cooldown)
        resolve()
      }
      audio.onerror = () => {
        audioCleanupRef.current?.()
        audioCleanupRef.current = null
        if (audioRef.current === audio) audioRef.current = null
        openEchoGate()
        reject(new Error('Không thể phát audio từ backend.'))
      }
      // Wait for browser to fully buffer audio before playing
      audio.oncanplaythrough = () => {
        audio.play().catch(() => {
          audioCleanupRef.current?.()
          audioCleanupRef.current = null
          if (audioRef.current === audio) audioRef.current = null
          openEchoGate()
          reject(new Error('Trình duyệt chặn phát audio tự động.'))
        })
      }
      audio.load()
    })
  }

  function createStreamingAudioPlayer():
    | {
        appendChunk: (chunk: Uint8Array) => void
        finalize: () => Promise<void>
      }
    | null {
    if (
      !synthesisSupported ||
      typeof MediaSource === 'undefined' ||
      !MediaSource.isTypeSupported('audio/mpeg')
    ) {
      return null
    }

    stopAudioPlayback()

    const audio = new Audio()
    const mediaSource = new MediaSource()
    const audioUrl = URL.createObjectURL(mediaSource)
    audio.src = audioUrl
    audio.preload = 'auto'
    audioRef.current = audio
    audioCleanupRef.current = () => {
      URL.revokeObjectURL(audioUrl)
    }
    closeEchoGate()

    let sourceBuffer: SourceBuffer | null = null
    let playStarted = false
    let finalized = false
    const pendingChunks: Uint8Array[] = []

    const playbackDone = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        audioCleanupRef.current?.()
        audioCleanupRef.current = null
        if (audioRef.current === audio) {
          audioRef.current = null
        }
      }

      audio.onended = () => {
        cleanup()
        openEchoGate()
        resolve()
      }
      audio.onerror = () => {
        cleanup()
        openEchoGate()
        reject(new Error('Không thể phát audio streaming từ backend.'))
      }
    })

    const flushBuffer = () => {
      if (!sourceBuffer || sourceBuffer.updating) {
        return
      }

      const nextChunk = pendingChunks.shift()
      if (nextChunk) {
        const safeChunk = new Uint8Array(nextChunk.byteLength)
        safeChunk.set(nextChunk)
        sourceBuffer.appendBuffer(safeChunk)
        if (!playStarted) {
          playStarted = true
          void audio.play().catch((error) => {
            console.warn('[useSpeech] Streaming audio autoplay blocked:', error)
          })
        }
        return
      }

      if (finalized && mediaSource.readyState === 'open') {
        try {
          mediaSource.endOfStream()
        } catch {
          // no-op
        }
      }
    }

    mediaSource.addEventListener('sourceopen', () => {
      sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg')
      sourceBuffer.mode = 'sequence'
      sourceBuffer.addEventListener('updateend', flushBuffer)
      flushBuffer()
    })

    return {
      appendChunk: (chunk: Uint8Array) => {
        pendingChunks.push(chunk)
        flushBuffer()
      },
      finalize: async () => {
        finalized = true
        flushBuffer()
        await playbackDone
      },
    }
  }

  function stopAudioPlayback() {
    if (!audioRef.current) return
    const a = audioRef.current
    audioRef.current = null
    a.pause()
    a.currentTime = 0
    audioCleanupRef.current?.()
    audioCleanupRef.current = null
    openEchoGate()  // immediately re-open gate on manual stop
  }

  function notifyOnce(key: string, message: string, level: 'warning' | 'info' = 'warning') {
    if (notifiedKeysRef.current.has(key)) return
    notifiedKeysRef.current.add(key)
    noticeHandlerRef.current(message, level)
  }

  /** Speak text while simultaneously listening for user input (barge-in enabled).
   * If the user starts speaking, bot audio is cut and their input is processed. */
  async function speakWithBargeIn(text: string): Promise<void> {
    if (!synthesisSupported) {
      throw new Error('Trình duyệt hiện tại không hỗ trợ phát audio.')
    }

    stopAudioPlayback()

    // Reset Pipeline B state for a clean concurrent listen
    clearSubmitTimer()
    clearInterimSubmitTimer()
    pendingSubmitTextRef.current = ''
    accumulatedFinalRef.current = ''
    lastInterimTextRef.current = ''
    resetTranscript()

    // Start listening concurrently — echo gate prevents bot audio being processed
    if (recognitionSupported) {
      try {
        await SpeechRecognition.startListening({
          continuous: true,
          interimResults: true,
          language: lang,
        })
        console.log('[useSpeech] Barge-in listener active during speech')
      } catch (error) {
        console.warn('[useSpeech] Could not start barge-in listener:', error)
      }
    }

    // Now speak (echo gate activates inside playAudioBlob)
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

      await playAudioBlob(new Blob([combined], { type: 'audio/mpeg' }))
    } catch {
      // Fallback to non-streaming
      try {
        const audioBlob = await synthesizeSpeech(text)
        await playAudioBlob(audioBlob)
      } catch {
        console.warn('[useSpeech] Both streaming and fallback TTS failed')
      }
    }
  }

  return {
    // Pipeline A — live caption, direct passthrough, zero overhead
    interimTranscript,
    // Core state
    listening,
    recognitionSupported,
    synthesisSupported,
    isSpeaking: isSpeakingRef.current,
    // Controls
    startListening,
    stopListening,
    speak,
    speakWithBargeIn,
    createStreamingAudioPlayer,
    stopAudioPlayback,
    ensureAudioWakeLock,
  }
}

// Global wake lock state to completely prevent Bluetooth/OS audio truncation
let wakeLockAudioContext: AudioContext | null = null
type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext }

function ensureAudioWakeLock() {
  if (typeof window === 'undefined') return
  if (!wakeLockAudioContext) {
    try {
      const AudioCtx = window.AudioContext || (window as AudioWindow).webkitAudioContext
      if (!AudioCtx) return
      
      const ctx = new AudioCtx()
      
      // Create a permanently running, completely silent oscillator
      // This forces the audio hardware to stay alive without audible noise!
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      gain.gain.value = 0.0001 // practically silent
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      
      wakeLockAudioContext = ctx
      console.log('[useSpeech] Audio wake lock activated to prevent TTS truncation.')
    } catch {
      // Ignore audio context errors
    }
  } else if (wakeLockAudioContext.state === 'suspended') {
    void wakeLockAudioContext.resume()
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
