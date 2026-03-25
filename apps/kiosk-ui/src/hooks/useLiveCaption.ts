import { useEffect, useRef, useState } from 'react'

type UseLiveCaptionOptions = {
  lang: string
}

export type LiveCaptionStatus =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'stopping'
  | 'unsupported'
  | 'error'

const RESTART_DELAY_MS = 180

export function useLiveCaption({ lang }: UseLiveCaptionOptions) {
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const shouldRestartRef = useRef(false)
  const restartTimerRef = useRef<number | null>(null)
  const [status, setStatus] = useState<LiveCaptionStatus>('idle')
  const [interimTranscript, setInterimTranscript] = useState('')
  const [finalTranscript, setFinalTranscript] = useState('')
  const [error, setError] = useState('')

  const supported =
    typeof window !== 'undefined' &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)

  useEffect(() => {
    return () => {
      shouldRestartRef.current = false
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current)
        restartTimerRef.current = null
      }
      if (recognitionRef.current) {
        recognitionRef.current.onstart = null
        recognitionRef.current.onresult = null
        recognitionRef.current.onerror = null
        recognitionRef.current.onend = null
        recognitionRef.current.abort()
        recognitionRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (recognitionRef.current) {
      recognitionRef.current.lang = lang
    }
  }, [lang])

  async function start() {
    if (!supported) {
      setStatus('unsupported')
      setError('Browser nay khong ho tro SpeechRecognition native cho live caption.')
      return
    }

    if (status === 'starting' || status === 'listening') {
      return
    }

    setError('')
    setStatus('starting')
    shouldRestartRef.current = true

    const recognition = ensureRecognition(lang, {
      onStart: () => {
        setStatus('listening')
        setError('')
      },
      onResult: ({ finalText, interimText }) => {
        setFinalTranscript(finalText)
        setInterimTranscript(interimText)
      },
      onError: (event) => {
        if (event.error === 'aborted') {
          return
        }

        const message = event.message || `Speech recognition error: ${event.error}`
        setError(message)
        setStatus('error')
      },
      onEnd: () => {
        if (!shouldRestartRef.current) {
          setStatus('idle')
          setInterimTranscript('')
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
            setStatus('error')
          }
        }, RESTART_DELAY_MS)
      },
    })

    try {
      recognition.start()
    } catch (error) {
      setStatus('error')
      setError(error instanceof Error ? error.message : 'Khong the bat live caption.')
    }
  }

  function stop() {
    shouldRestartRef.current = false
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current)
      restartTimerRef.current = null
    }

    const recognition = recognitionRef.current
    if (!recognition) {
      setStatus('idle')
      return
    }

    setStatus('stopping')
    try {
      recognition.stop()
    } catch {
      recognition.abort()
      setStatus('idle')
    }
  }

  function clear() {
    setInterimTranscript('')
    setFinalTranscript('')
    setError('')
    if (status === 'error') {
      setStatus('idle')
    }
  }

  return {
    supported,
    status,
    interimTranscript,
    finalTranscript,
    error,
    start,
    stop,
    clear,
    isListening: status === 'starting' || status === 'listening',
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
}
