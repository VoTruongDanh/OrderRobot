import * as blazeface from '@tensorflow-models/blazeface'
import '@tensorflow/tfjs'
import * as tf from '@tensorflow/tfjs'
import { useEffect, useRef, useState } from 'react'

type UsePresenceDetectionOptions = {
  onNotice: (message: string) => void
}

export function usePresenceDetection({ onNotice }: UsePresenceDetectionOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<blazeface.BlazeFaceModel | null>(null)
  const noticeHandlerRef = useRef(onNotice)
  const notifiedKeysRef = useRef<Set<string>>(new Set())
  const [cameraReady, setCameraReady] = useState(false)
  const [presenceDetected, setPresenceDetected] = useState(false)
  const [detectorSupported, setDetectorSupported] = useState(false)

  useEffect(() => {
    noticeHandlerRef.current = onNotice
  }, [onNotice])

  useEffect(() => {
    let disposed = false
    let detectorInterval: number | undefined
    let positiveFrames = 0
    let negativeFrames = 0

    const notifyOnce = (key: string, message: string) => {
      if (notifiedKeysRef.current.has(key)) {
        return
      }

      notifiedKeysRef.current.add(key)
      noticeHandlerRef.current(message)
    }

    async function ensureBackendReady() {
      const preferredBackends = ['webgl', 'cpu']

      for (const backend of preferredBackends) {
        try {
          const switched = await tf.setBackend(backend)
          if (switched) {
            await tf.ready()
            return true
          }
        } catch {
          continue
        }
      }

      return false
    }

    async function setupDetector() {
      const backendReady = await ensureBackendReady()
      if (!backendReady) {
        notifyOnce(
          'face-backend',
          'Thư viện nhận diện khuôn mặt chưa khởi tạo được, robot sẽ chờ bạn bấm Bắt đầu thủ công.',
        )
        return null
      }

      try {
        const detector = await blazeface.load({
          maxFaces: 1,
          inputWidth: 128,
          inputHeight: 128,
          scoreThreshold: 0.8,
        })

        if (disposed) {
          detector.dispose()
          return null
        }

        detectorRef.current = detector
        setDetectorSupported(true)
        return detector
      } catch {
        notifyOnce(
          'face-detector-init',
          'Không thể tải thư viện nhận diện khuôn mặt, robot vẫn có thể demo bằng chế độ thủ công.',
        )
        return null
      }
    }

    async function setupCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        notifyOnce('camera-api', 'Trình duyệt chưa hỗ trợ camera API, vui lòng dùng chế độ thủ công.')
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })

        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        streamRef.current = stream
        const element = videoRef.current
        if (element) {
          element.srcObject = stream
          await element.play()
          setCameraReady(true)
        }

        const detector = await setupDetector()
        if (!detector) {
          return
        }

        detectorInterval = window.setInterval(async () => {
          const video = videoRef.current
          if (!video || video.readyState < 2) {
            return
          }

          try {
            const faces = await detector.estimateFaces(video, false, true, false)

            if (faces.length > 0) {
              positiveFrames += 1
              negativeFrames = 0
            } else {
              positiveFrames = 0
              negativeFrames += 1
            }

            if (positiveFrames >= 2) {
              setPresenceDetected(true)
            }
            if (negativeFrames >= 3) {
              setPresenceDetected(false)
            }
          } catch {
            setPresenceDetected(false)
          }
        }, 1800)
      } catch {
        notifyOnce(
          'camera-permission',
          'Camera chưa được cấp quyền hoặc đang bận, robot sẽ chờ bạn bấm Bắt đầu thủ công.',
        )
      }
    }

    void setupCamera()

    return () => {
      disposed = true
      if (detectorInterval) {
        window.clearInterval(detectorInterval)
      }
      detectorRef.current?.dispose()
      detectorRef.current = null
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  return {
    videoRef,
    cameraReady,
    presenceDetected,
    detectorSupported,
  }
}
