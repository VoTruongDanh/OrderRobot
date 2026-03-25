import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { fetchMenu, fetchOrder, resetSession, sendTurnStream, startSession, saveFeedback } from './api'
import { MenuBoard } from './components/MenuBoard'
import { OrderSuccessModal } from './components/OrderSuccessModal'
import { RobotAvatar } from './components/RobotAvatar'
import { TranscriptPanel } from './components/TranscriptPanel'
import { usePresenceDetection } from './hooks/usePresenceDetection'
import { useSpeech } from './hooks/useSpeech'
import type {
  AppNotice,
  ConversationResponse,
  InvoiceSnapshot,
  MenuItem,
  OrderRecord,
  RobotMode,
  TranscriptEntry,
} from './types'

function App() {
  const [menu, setMenu] = useState<MenuItem[]>([])
  const [loadingMenu, setLoadingMenu] = useState(true)
  const [menuError, setMenuError] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [transcriptEntries, setTranscriptEntries] = useState<TranscriptEntry[]>([])
  const [cart, setCart] = useState<ConversationResponse['cart']>([])
  const [recommendedItemIds, setRecommendedItemIds] = useState<string[]>([])
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)
  const [invoice, setInvoice] = useState<InvoiceSnapshot | null>(null)
  const [successModalInvoice, setSuccessModalInvoice] = useState<InvoiceSnapshot | null>(null)
  const [feedbackSessionId, setFeedbackSessionId] = useState<string | null>(null)
  const [successCountdown, setSuccessCountdown] = useState(6)
  const [robotMode, setRobotMode] = useState<RobotMode>('detecting')
  const [notices, setNotices] = useState<AppNotice[]>([])
  const [statusMessage, setStatusMessage] = useState(
    'Robot đang chờ khách đứng vào vị trí để bắt đầu chào hỏi.',
  )
  const [awaitingVacancy, setAwaitingVacancy] = useState(false)

  const sessionIdRef = useRef<string | null>(null)
  const isBusyRef = useRef(false)
  const currentTurnAbortRef = useRef<AbortController | null>(null)
  const activeTurnRequestIdRef = useRef(0)
  const handleAssistantResponseRef = useRef<
    (response: ConversationResponse, options?: { autoListen?: boolean }) => Promise<void>
  >(async () => {})
  const handleTranscriptRef = useRef<
    (transcript: string, options?: { interruptCurrent?: boolean }) => Promise<void>
  >(async () => {})

  // Random greeting messages for faster initial response
  const greetingMessages = [
    'Xin chào! Mình là robot đặt món. Bạn muốn gọi gì hôm nay?',
    'Chào bạn! Hôm nay bạn muốn thử món gì nhỉ?',
    'Xin chào! Mình sẵn sàng nhận order rồi. Bạn gọi món gì nào?',
    'Chào bạn! Bạn muốn uống gì hôm nay?',
    'Xin chào! Mình có thể giúp bạn đặt món ngay. Bạn muốn gọi gì?',
  ]

  const getRandomGreeting = useCallback(() => {
    return greetingMessages[Math.floor(Math.random() * greetingMessages.length)]
  }, [])

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const resetToWelcomeState = useCallback((options?: { waitForVacancy?: boolean }) => {
    const waitForVacancy = options?.waitForVacancy ?? false
    setSessionId(null)
    setFeedbackSessionId(null)
    setTranscriptEntries([])
    setCart([])
    setRecommendedItemIds([])
    setAwaitingConfirmation(false)
    setInvoice(null)
    setNotices([])
    setRobotMode('detecting')
    setStatusMessage(
      waitForVacancy
        ? 'Đơn đã hoàn tất. Robot đang chờ khu vực trống để đón khách tiếp theo.'
        : 'Robot đang chờ khách mới bước vào vùng camera.',
    )
    setAwaitingVacancy(waitForVacancy)
  }, [])

  const closeSuccessModal = useCallback(() => {
    setSuccessModalInvoice(null)
    setSuccessCountdown(6)
    resetToWelcomeState({ waitForVacancy: true })
  }, [resetToWelcomeState])

  const appendTranscript = useCallback((speaker: TranscriptEntry['speaker'], text: string) => {
    setTranscriptEntries((current) => [
      ...current,
      {
        id: `${speaker}-${crypto.randomUUID()}`,
        speaker,
        text,
        timestamp: new Date().toLocaleTimeString('vi-VN', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      },
    ])
  }, [])

  const addNotice = useCallback((text: string, level: AppNotice['level'] = 'warning') => {
    setNotices((current) => {
      if (current.some((notice) => notice.text === text)) {
        return current
      }

      return [
        ...current,
        {
          id: crypto.randomUUID(),
          level,
          text,
        },
      ]
    })
  }, [])

  const handleUiError = useCallback((message: string) => {
    setRobotMode('error')
    setStatusMessage(message)
    setTranscriptEntries((current) => {
      const lastEntry = current[current.length - 1]
      if (lastEntry?.speaker === 'system' && lastEntry.text === message) {
        return current
      }

      return [
        ...current,
        {
          id: `system-${crypto.randomUUID()}`,
          speaker: 'system',
          text: message,
          timestamp: new Date().toLocaleTimeString('vi-VN', {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
      ]
    })
  }, [])

  const {
    interimTranscript,
    recognitionSupported,
    synthesisSupported,
    speak,
    speakWithBargeIn,
    createStreamingAudioPlayer,
    startListening,
    stopListening,
    ensureAudioWakeLock,
    listening,
  } = useSpeech({
    lang: 'vi-VN',
    onTranscript: (transcript) => {
      void handleTranscriptRef.current(transcript, {
        interruptCurrent: isBusyRef.current,
      })
    },
    onNotice: addNotice,
    onBargeIn: () => {
      console.log('[App] User barged in — switching to listening mode')
      currentTurnAbortRef.current?.abort()
      setRobotMode('listening')
      setStatusMessage('Robot đã ngừng nói và đang nghe mình...')
    },
  })

  const { videoRef, cameraReady, detectorSupported, presenceDetected } = usePresenceDetection({
    onNotice: addNotice,
  })

  useEffect(() => {
    if (robotMode !== 'listening') {
      return
    }

    if (interimTranscript) {
      setStatusMessage(`Robot đang nghe: "${interimTranscript}"`)
      return
    }

    setStatusMessage('Robot đang nghe, bạn nói tên món hoặc yêu cầu thêm nhé.')
  }, [interimTranscript, robotMode])

  useEffect(() => {
    if (!recognitionSupported) {
      addNotice(
        'Thiết bị hiện tại không hỗ trợ nhận giọng nói trực tiếp trên trình duyệt. Hãy dùng Chrome hoặc Edge mới để robot nghe được tiếng nói.',
      )
    }
  }, [addNotice, recognitionSupported])

  useEffect(() => {
    if (!synthesisSupported) {
      addNotice('Thiết bị hiện tại không hỗ trợ phát audio trả về từ backend.')
    }
  }, [addNotice, synthesisSupported])

  useEffect(() => {
    handleAssistantResponseRef.current = async (response, options) => {
      const autoListen = options?.autoListen ?? true
      setSessionId(response.session_id)
      setCart(response.cart)
      setRecommendedItemIds(response.recommended_item_ids)
      setAwaitingConfirmation(response.needs_confirmation)
      setRobotMode('speaking')

      setStatusMessage(
        response.order_created
          ? 'Robot đã tạo đơn xong và đang hiển thị hóa đơn.'
          : response.needs_confirmation
            ? 'Robot đang đọc lại giỏ để chờ khách xác nhận.'
            : 'Robot đang phản hồi bằng giọng nói từ backend.',
      )
      appendTranscript('assistant', response.reply_text)

      if (response.order_created) {
        const orderId = response.order_id
        const fallbackInvoice = buildLocalInvoiceSnapshot({
          orderId: orderId ?? `TMP-${Date.now()}`,
          createdAt: new Date(),
          items: response.cart,
          totalAmount: response.cart.reduce((sum, item) => sum + Number(item.line_total), 0),
        })

        setInvoice(fallbackInvoice)
        setSuccessModalInvoice(fallbackInvoice)
        setSuccessCountdown(6)
        setStatusMessage('Đơn đã được xác nhận. Kiosk đang hiển thị mã QR cho khách.')
        setCart([])
        setAwaitingConfirmation(false)
        setFeedbackSessionId(response.session_id)
        setSessionId(null)
        setAwaitingVacancy(false)

        if (orderId) {
          void (async () => {
            try {
              const order = await fetchOrder(orderId)
              const completedInvoice = buildInvoiceSnapshot(order)
              setInvoice(completedInvoice)
              setSuccessModalInvoice(completedInvoice)
            } catch (error) {
              const message =
                error instanceof Error
                  ? `Đã tạo đơn nhưng không tải được hóa đơn: ${error.message}`
                  : 'Đã tạo đơn nhưng không tải được hóa đơn.'
              addNotice(message, 'info')
            }
          })()
        }

        try {
          await speak(response.reply_text)
        } catch (error) {
          const message =
            error instanceof Error
              ? `Không phát được audio từ backend: ${error.message}`
              : 'Không phát được audio từ backend.'
          addNotice(message, 'info')
        } finally {
          setRobotMode('idle')
        }
        return
      }

      try {
        await speakWithBargeIn(response.reply_text)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          console.log('[submitIntent] Turn interrupted before completion')
          return
        }

        const message =
          error instanceof Error
            ? `Không phát được audio từ backend: ${error.message}`
            : 'Không phát được audio từ backend.'
        addNotice(message, 'info')
      }

      // Mic is already open from speakWithBargeIn, just update mode
      if (recognitionSupported && autoListen) {
        setRobotMode('listening')
        setStatusMessage('Robot đang nghe yêu cầu tiếp theo để tiếp tục đặt món.')
      } else {
        setRobotMode('idle')
      }
    }
  }, [addNotice, appendTranscript, recognitionSupported, speakWithBargeIn])

  useEffect(() => {
    if (!successModalInvoice) {
      return
    }

    setSuccessCountdown(6)
    const countdownInterval = window.setInterval(() => {
      setSuccessCountdown((current) => {
        if (current <= 1) {
          window.clearInterval(countdownInterval)
          return 0
        }
        return current - 1
      })
    }, 1000)

    // Close after 16s total (6s invoice + 10s thank you UI)
    const closeTimer = window.setTimeout(() => {
      closeSuccessModal()
    }, 16000)

    return () => {
      window.clearInterval(countdownInterval)
      window.clearTimeout(closeTimer)
    }
  }, [closeSuccessModal, successModalInvoice])

  const createSilentSession = useCallback(async () => {
    const response = await startSession('manual')
    setSessionId(response.session_id)
    setTranscriptEntries([])
    setRecommendedItemIds([])
    setAwaitingConfirmation(false)
    setInvoice(null)
    setSuccessModalInvoice(null)
    setFeedbackSessionId(null)
    setSuccessCountdown(6)
    setAwaitingVacancy(false)
    return response.session_id
  }, [])

  const submitIntent = useCallback(
    async (transcript: string, options?: { ensureSession?: boolean; interruptCurrent?: boolean }) => {
      const interruptCurrent = options?.interruptCurrent ?? false

      if (isBusyRef.current && !interruptCurrent) {
        return
      }

      if (interruptCurrent) {
        currentTurnAbortRef.current?.abort()
      }

      const turnRequestId = activeTurnRequestIdRef.current + 1
      activeTurnRequestIdRef.current = turnRequestId
      const turnAbortController = new AbortController()
      currentTurnAbortRef.current = turnAbortController

      stopListening()
      isBusyRef.current = true
      appendTranscript('user', transcript)
      setRobotMode('thinking')
      setStatusMessage('Robot đang đối chiếu yêu cầu với menu và giỏ hàng...')

      try {
        let activeSessionId = sessionIdRef.current
        if (!activeSessionId && options?.ensureSession !== false) {
          activeSessionId = await createSilentSession()
        }

        if (!activeSessionId) {
          throw new Error('Chưa có phiên AI hoạt động.')
        }

        // Use streaming API for lower latency
        let fullText = ''
        const audioChunks: Uint8Array[] = []
        let streamingAudioPlayer: ReturnType<typeof createStreamingAudioPlayer> | null = null
        let receivedStreamingAudio = false
        let bargeInListeningStarted = false
        let cartData: ConversationResponse['cart'] = []
        let orderCreatedDetected = false
        let detectedOrderId: string | null = null

        setRobotMode('speaking')
        setStatusMessage('Robot đang phản hồi...')

        for await (const chunk of sendTurnStream(activeSessionId, transcript, turnAbortController.signal)) {
          if (chunk.type === 'text') {
            fullText += chunk.content
            
            // Update cart if provided
            if (chunk.cart) {
              cartData = chunk.cart
              setCart(cartData)
            }
            
            // Detect order creation early to show popup immediately
            if (!orderCreatedDetected && (fullText.includes('đã lên đơn thành công') || fullText.includes('mã đơn'))) {
              orderCreatedDetected = true
              const orderIdMatch = fullText.match(/mã\s+([A-Z0-9-]+)/i)
              detectedOrderId = orderIdMatch?.[1] ?? null
              
              // Show popup immediately when order is detected
              if (detectedOrderId) {
                const fallbackInvoice = buildLocalInvoiceSnapshot({
                  orderId: detectedOrderId,
                  createdAt: new Date(),
                  items: cartData,
                  totalAmount: cartData.reduce((sum, item) => sum + Number(item.line_total), 0),
                })

                setInvoice(fallbackInvoice)
                setSuccessModalInvoice(fallbackInvoice)
                setSuccessCountdown(6)
                setStatusMessage('Đơn đã được xác nhận. Kiosk đang hiển thị mã QR cho khách.')
                setCart([])
                setAwaitingConfirmation(false)
                setFeedbackSessionId(activeSessionId)
                setSessionId(null)
                setAwaitingVacancy(false)

                // Fetch real order data in background
                void (async () => {
                  try {
                    const order = await fetchOrder(detectedOrderId!)
                    const completedInvoice = buildInvoiceSnapshot(order)
                    setInvoice(completedInvoice)
                    setSuccessModalInvoice(completedInvoice)
                  } catch (error) {
                    const message =
                      error instanceof Error
                        ? `Đã tạo đơn nhưng không tải được hóa đơn: ${error.message}`
                        : 'Đã tạo đơn nhưng không tải được hóa đơn.'
                    addNotice(message, 'info')
                  }
                })()
              }
            }
            
            // Show progressive text in transcript
            setTranscriptEntries((current) => {
              const lastEntry = current[current.length - 1]
              if (lastEntry?.speaker === 'assistant' && lastEntry.id.startsWith('streaming-')) {
                return [
                  ...current.slice(0, -1),
                  {
                    ...lastEntry,
                    text: fullText,
                  },
                ]
              }
              
              return [
                ...current,
                {
                  id: `streaming-${crypto.randomUUID()}`,
                  speaker: 'assistant',
                  text: fullText,
                  timestamp: new Date().toLocaleTimeString('vi-VN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                },
              ]
            })
          } else if (chunk.type === 'audio') {
            if (recognitionSupported && !bargeInListeningStarted && !orderCreatedDetected) {
              bargeInListeningStarted = true
              try {
                await startListening()
                console.log('[submitIntent] Barge-in listening active during streaming audio')
              } catch (error) {
                console.warn('[submitIntent] Could not start barge-in listening during audio:', error)
              }
            }

            const audioData = Uint8Array.from(atob(chunk.content), c => c.charCodeAt(0))
            if (!streamingAudioPlayer && !orderCreatedDetected) {
              streamingAudioPlayer = createStreamingAudioPlayer()
            }

            if (streamingAudioPlayer && !orderCreatedDetected) {
              receivedStreamingAudio = true
              streamingAudioPlayer.appendChunk(audioData)
            } else {
              audioChunks.push(audioData)
            }
          }
        }

        // Finalize transcript entry with complete text
        setTranscriptEntries((current) => {
          const lastEntry = current[current.length - 1]
          if (lastEntry?.speaker === 'assistant' && lastEntry.id.startsWith('streaming-')) {
            return [
              ...current.slice(0, -1),
              {
                ...lastEntry,
                id: `assistant-${crypto.randomUUID()}`,
                text: fullText,
              },
            ]
          }
          return current
        })

        if (streamingAudioPlayer && receivedStreamingAudio && !orderCreatedDetected) {
          try {
            await streamingAudioPlayer.finalize()
          } catch (error) {
            console.warn('Failed to finalize streaming audio:', error)
            addNotice('KhÃ´ng thá»ƒ phÃ¡t audio tá»« backend.', 'info')
          }
        } else if (audioChunks.length > 0 && !orderCreatedDetected) {
          try {
            const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)
            const combinedAudio = new Uint8Array(totalLength)
            let offset = 0
            for (const chunk of audioChunks) {
              combinedAudio.set(chunk, offset)
              offset += chunk.length
            }
            const audioBlob = new Blob([combinedAudio], { type: 'audio/mpeg' })
            const audioUrl = URL.createObjectURL(audioBlob)
            const audio = new Audio(audioUrl)
            audio.preload = 'auto'  // tell browser to fully buffer before play

            await new Promise<void>((resolve, reject) => {
              audio.onended = () => {
                URL.revokeObjectURL(audioUrl)
                resolve()
              }
              audio.onerror = () => {
                URL.revokeObjectURL(audioUrl)
                reject(new Error('Audio playback failed'))
              }
              // Wait for browser to buffer audio before playing to prevent cut-off at start
              audio.oncanplaythrough = () => {
                audio.play().catch(reject)
              }
              audio.load()
            })
          } catch (error) {
            console.warn('Failed to play streaming audio:', error)
            addNotice('Không thể phát audio từ backend.', 'info')
          }
        } else if (audioChunks.length > 0 && orderCreatedDetected) {
          // For order completion, play audio with proper buffering
          try {
            const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)
            const combinedAudio = new Uint8Array(totalLength)
            let offset = 0
            for (const chunk of audioChunks) {
              combinedAudio.set(chunk, offset)
              offset += chunk.length
            }
            const audioBlob = new Blob([combinedAudio], { type: 'audio/mpeg' })
            const audioUrl = URL.createObjectURL(audioBlob)
            const audio = new Audio(audioUrl)
            audio.preload = 'auto'
            audio.onended = () => URL.revokeObjectURL(audioUrl)
            audio.oncanplaythrough = () => void audio.play()
            audio.load()
          } catch {
            // Ignore audio errors on order completion — popup is the priority
          }
        }

        // If order was created, we're done (popup already shown)
        if (orderCreatedDetected) {
          setRobotMode('idle')
          return
        }

        // Restart listening after streaming response
        if (recognitionSupported) {
          setRobotMode('listening')
          setStatusMessage('Robot đang nghe yêu cầu tiếp theo để tiếp tục đặt món.')
          if (!bargeInListeningStarted) {
            try {
              await startListening()
              console.log('[submitIntent] Successfully restarted listening after streaming')
            } catch (error) {
              console.error('[submitIntent] Failed to restart listening:', error)
              setRobotMode('idle')
            }
          }
        } else {
          setRobotMode('idle')
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          console.log('[submitIntent] Turn interrupted before completion')
          return
        }

        const message =
          error instanceof Error
            ? `Em xin lỗi, backend AI đang gặp lỗi: ${error.message}`
            : 'Em xin lỗi, backend AI đang gặp lỗi.'
        handleUiError(message)
        setSessionId(null)
        setCart([])
        setRecommendedItemIds([])
        setAwaitingConfirmation(false)
      } finally {
        if (currentTurnAbortRef.current === turnAbortController) {
          currentTurnAbortRef.current = null
        }
        if (activeTurnRequestIdRef.current === turnRequestId) {
          isBusyRef.current = false
        }
      }
    },
    [
      addNotice,
      appendTranscript,
      createSilentSession,
      createStreamingAudioPlayer,
      handleUiError,
      recognitionSupported,
      startListening,
      stopListening,
    ],
  )

  useEffect(() => {
    handleTranscriptRef.current = async (transcript: string, options) => {
      await submitIntent(transcript, options)
    }
  }, [submitIntent])

  useEffect(() => {
    async function loadMenu() {
      setLoadingMenu(true)
      try {
        const items = await fetchMenu()
        setMenu(items)
      } catch (error) {
        setMenuError(error instanceof Error ? error.message : 'Không thể tải menu từ core backend.')
      } finally {
        setLoadingMenu(false)
      }
    }

    void loadMenu()
  }, [])

  const beginSession = useCallback(
    async (source: 'camera' | 'manual') => {
      if (isBusyRef.current) {
        return
      }

      // Initialize wake lock immediately on interaction
      ensureAudioWakeLock()

      isBusyRef.current = true
      stopListening()
      setRobotMode('speaking')
      
      // Get random greeting and play immediately for faster response
      const greetingText = getRandomGreeting()
      setStatusMessage('Robot đang chào khách...')

      try {
        // Play greeting audio immediately without waiting for backend session
        const speakPromise = speak(greetingText).catch((error) => {
          const message =
            error instanceof Error
              ? `Không phát được audio chào: ${error.message}`
              : 'Không phát được audio chào.'
          addNotice(message, 'info')
        })

        // Start backend session in parallel
        const sessionPromise = startSession(source)

        // Wait for both to complete
        const [, response] = await Promise.all([speakPromise, sessionPromise])

        setSessionId(response.session_id)
        setTranscriptEntries((current) => [
          ...current,
          {
            id: `assistant-${crypto.randomUUID()}`,
            speaker: 'assistant',
            text: greetingText,
            timestamp: new Date().toLocaleTimeString('vi-VN', {
              hour: '2-digit',
              minute: '2-digit',
            }),
          },
        ])
        setRecommendedItemIds([])
        setAwaitingConfirmation(false)
        setInvoice(null)
        setSuccessModalInvoice(null)
        setFeedbackSessionId(null)
        setSuccessCountdown(6)
        setAwaitingVacancy(false)

        // Auto-listen after greeting
        if (recognitionSupported) {
          setRobotMode('listening')
          setStatusMessage('Robot đang nghe yêu cầu tiếp theo để tiếp tục đặt món.')
          try {
            await startListening()
            console.log('[beginSession] Successfully started listening after greeting')
          } catch (error) {
            console.error('[beginSession] Failed to start listening:', error)
            setRobotMode('idle')
          }
        } else {
          setRobotMode('idle')
        }
      } catch (error) {
        const message =
          error instanceof Error ? `Không thể mở phiên AI: ${error.message}` : 'Không thể mở phiên AI.'
        setAwaitingVacancy(true)
        handleUiError(message)
      } finally {
        isBusyRef.current = false
      }
    },
    [addNotice, getRandomGreeting, handleUiError, recognitionSupported, speak, startListening, stopListening],
  )

  useEffect(() => {
    if (successModalInvoice) {
      return
    }

    if (!presenceDetected) {
      setAwaitingVacancy(false)
      if (!sessionIdRef.current && !isBusyRef.current) {
        setRobotMode('detecting')
        setStatusMessage('Robot đang chờ khách mới bước vào vùng camera.')
      }
      return
    }

    if (!sessionIdRef.current && !awaitingVacancy && !isBusyRef.current) {
      void beginSession('camera')
    }
  }, [awaitingVacancy, beginSession, presenceDetected, successModalInvoice])

  const handleReset = useCallback(async () => {
    stopListening()
    setInvoice(null)
    setSuccessModalInvoice(null)
    setSuccessCountdown(6)
    if (!sessionIdRef.current) {
      setTranscriptEntries([])
      setCart([])
      setRecommendedItemIds([])
      setAwaitingConfirmation(false)
      setRobotMode('idle')
      setStatusMessage('Phiên demo đã được làm mới.')
      return
    }

    try {
      const response = await resetSession(sessionIdRef.current)
      setCart(response.cart)
      setRecommendedItemIds(response.recommended_item_ids)
      setAwaitingConfirmation(false)
      appendTranscript('system', 'Phiên hiện tại đã được làm mới.')
      await handleAssistantResponseRef.current(response)
    } catch (error) {
      handleUiError(error instanceof Error ? error.message : 'Không thể làm mới phiên hiện tại.')
    }
  }, [appendTranscript, handleUiError, stopListening])

  return (
    <div className="app-shell">
      <div className="bg-orb bg-orb--one" />
      <div className="bg-orb bg-orb--two" />
      <main className="dashboard">
        <section className="main-stage">
          <section className="hero-zone">
            <RobotAvatar mode={robotMode} statusMessage={statusMessage} />
            <section className="camera-strip camera-strip--compact">
              <div className="camera-frame camera-frame--compact">
                <video playsInline muted ref={videoRef} />
              </div>
              <div className="camera-strip__copy">
                <p className="eyebrow">Camera</p>
                <h2>{presenceDetected ? 'Khách đã vào vị trí' : 'Đang chờ khách đứng vào vị trí'}</h2>
                <p>
                  {presenceDetected
                    ? 'Robot có thể chủ động chào hỏi và nhận đơn bằng giọng nói.'
                    : 'Nếu camera chưa nhận diện ổn định, vẫn có thể bấm "Bắt đầu".'}
                </p>
                {menuError ? <p className="error-copy">Menu lỗi: {menuError}</p> : null}
              </div>
            </section>
          </section>

          <TranscriptPanel
            awaitingConfirmation={awaitingConfirmation}
            cameraReady={cameraReady}
            canListen={recognitionSupported}
            canSpeak={synthesisSupported}
            cart={cart}
            detectorSupported={detectorSupported}
            entries={transcriptEntries}
            invoice={invoice}
            liveTranscript={interimTranscript}
            notices={notices}
            speechPhase={listening ? 'listening' : 'idle'}
            onConfirmOrder={() => {
              void submitIntent('xác nhận')
            }}
            onManualListen={async () => {
              try {
                await startListening()
              } catch (error) {
                console.error('[Manual listen] Failed:', error)
              }
            }}
            onStopListening={() => {
              stopListening()
            }}
            onManualStart={() => {
              void beginSession('manual')
            }}
            onReset={() => {
              void handleReset()
            }}
            sessionActive={Boolean(sessionId)}
          />

          {loadingMenu ? (
            <section className="menu-panel">
              <div className="empty-state">Đang tải menu từ core backend...</div>
            </section>
          ) : (
            <MenuBoard
              cart={cart}
              items={menu}
              onAddItem={(item) => {
                void submitIntent(`Cho mình 1 ${item.name}`)
              }}
              onAskItem={(item) => {
                void submitIntent(`Tư vấn giúp mình món ${item.name} với`)
              }}
              recommendedItemIds={recommendedItemIds}
            />
          )}
        </section>
      </main>
      {successModalInvoice ? (
        <OrderSuccessModal
          countdown={successCountdown}
          invoice={successModalInvoice}
          onClose={closeSuccessModal}
          onFeedbackSubmit={(rating, comment) => {
            if (feedbackSessionId) {
              void saveFeedback(
                feedbackSessionId,
                rating,
                comment,
                transcriptEntries.map((e) => `${e.speaker}: ${e.text}`)
              )
            }
            closeSuccessModal()
          }}
        />
      ) : null}
    </div>
  )
}

function buildInvoiceSnapshot(order: OrderRecord): InvoiceSnapshot {
  return buildLocalInvoiceSnapshot({
    orderId: order.order_id,
    createdAt: new Date(order.created_at),
    items: order.items,
    totalAmount: Number(order.total_amount),
  })
}

function buildLocalInvoiceSnapshot(order: {
  orderId: string
  createdAt: Date
  items: OrderRecord['items']
  totalAmount: number
}): InvoiceSnapshot {
  const qrValue = JSON.stringify({
    order_id: order.orderId,
    created_at: order.createdAt.toISOString(),
    total_amount: order.totalAmount,
    items: order.items.map((item) => ({
      item_id: item.item_id,
      name: item.name,
      quantity: item.quantity,
      line_total: item.line_total,
    })),
  })

  return {
    orderId: order.orderId,
    createdAt: order.createdAt.toLocaleString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }),
    items: order.items,
    totalAmount: order.totalAmount,
    qrValue,
  }
}

export default App
