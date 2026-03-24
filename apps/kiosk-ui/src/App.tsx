import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { fetchMenu, fetchOrder, resetSession, sendTurn, startSession } from './api'
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
  const [successCountdown, setSuccessCountdown] = useState(6)
  const [liveTranscript, setLiveTranscript] = useState('')
  const [robotMode, setRobotMode] = useState<RobotMode>('detecting')
  const [notices, setNotices] = useState<AppNotice[]>([])
  const [statusMessage, setStatusMessage] = useState(
    'Robot đang chờ khách đứng vào vị trí để bắt đầu chào hỏi.',
  )
  const [awaitingVacancy, setAwaitingVacancy] = useState(false)

  const sessionIdRef = useRef<string | null>(null)
  const isBusyRef = useRef(false)
  const handleAssistantResponseRef = useRef<
    (response: ConversationResponse, options?: { autoListen?: boolean }) => Promise<void>
  >(async () => {})
  const handleTranscriptRef = useRef<(transcript: string) => Promise<void>>(async () => {})

  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const resetToWelcomeState = useCallback((options?: { waitForVacancy?: boolean }) => {
    const waitForVacancy = options?.waitForVacancy ?? false
    setSessionId(null)
    setTranscriptEntries([])
    setCart([])
    setRecommendedItemIds([])
    setAwaitingConfirmation(false)
    setInvoice(null)
    setNotices([])
    setLiveTranscript('')
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
    listening,
    recognitionSupported,
    synthesisSupported,
    speak,
    startListening,
    stopListening,
  } = useSpeech({
    lang: 'vi-VN',
    onTranscript: (transcript) => {
      setLiveTranscript('')
      void handleTranscriptRef.current(transcript)
    },
    onPartialTranscript: (transcript) => {
      setLiveTranscript(transcript)
      setStatusMessage(`Robot đang nghe: "${transcript}"`)
    },
    onNotice: addNotice,
  })

  const { videoRef, cameraReady, detectorSupported, presenceDetected } = usePresenceDetection({
    onNotice: addNotice,
  })

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
        await speak(response.reply_text)
      } catch (error) {
        const message =
          error instanceof Error
            ? `Không phát được audio từ backend: ${error.message}`
            : 'Không phát được audio từ backend.'
        addNotice(message, 'info')
      }

      if (recognitionSupported && autoListen) {
        setRobotMode('listening')
        setStatusMessage('Robot đang nghe yêu cầu tiếp theo để tiếp tục đặt món.')
        void startListening()
      } else {
        setRobotMode('idle')
      }
    }
  }, [addNotice, appendTranscript, recognitionSupported, speak, startListening])

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

    const closeTimer = window.setTimeout(() => {
      closeSuccessModal()
    }, 6000)

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
    setSuccessCountdown(6)
    setAwaitingVacancy(false)
    return response.session_id
  }, [])

  const submitIntent = useCallback(
    async (transcript: string, options?: { ensureSession?: boolean }) => {
      if (isBusyRef.current) {
        return
      }

      stopListening()
      isBusyRef.current = true
      setLiveTranscript('')
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

        const response = await sendTurn(activeSessionId, transcript)
        await handleAssistantResponseRef.current(response)
      } catch (error) {
        const message =
          error instanceof Error
            ? `Em xin lỗi, backend AI đang gặp lỗi: ${error.message}`
            : 'Em xin lỗi, backend AI đang gặp lỗi.'
        handleUiError(message)
        setSessionId(null)
        setCart([])
        setRecommendedItemIds([])
        setAwaitingConfirmation(false)
        setLiveTranscript('')
      } finally {
        isBusyRef.current = false
      }
    },
    [appendTranscript, createSilentSession, handleUiError, stopListening],
  )

  useEffect(() => {
    handleTranscriptRef.current = async (transcript: string) => {
      await submitIntent(transcript)
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

      isBusyRef.current = true
      stopListening()
      setRobotMode('thinking')
      setStatusMessage('Robot đang mở phiên mới và chuẩn bị chào khách...')

      try {
        const response = await startSession(source)
        setTranscriptEntries([])
        setRecommendedItemIds([])
        setAwaitingConfirmation(false)
        setInvoice(null)
        setSuccessModalInvoice(null)
        setSuccessCountdown(6)
        setLiveTranscript('')
        setAwaitingVacancy(false)
        await handleAssistantResponseRef.current(response)
      } catch (error) {
        const message =
          error instanceof Error ? `Không thể mở phiên AI: ${error.message}` : 'Không thể mở phiên AI.'
        setAwaitingVacancy(true)
        handleUiError(message)
      } finally {
        isBusyRef.current = false
      }
    },
    [handleUiError, stopListening],
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
    setLiveTranscript('')
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
            listening={listening}
            liveTranscript={liveTranscript}
            notices={notices}
            onConfirmOrder={() => {
              void submitIntent('xác nhận')
            }}
            onManualListen={() => {
              void startListening()
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
