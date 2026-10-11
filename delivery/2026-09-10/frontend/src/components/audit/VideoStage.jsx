import { useEffect, useRef, useState } from 'react'
import { getAccessToken } from '../../store/authStore'
import { API_BASE_URL } from '../../config/constants'

// ---------------------------------------------------------------------------
// Video stage
// ---------------------------------------------------------------------------
// The third recording format, and the only one that is not a stream of events
// this console replays itself.
//
// A DESKTOP application session is captured as video by the agent's screen
// recorder, because a desktop client has no terminal for PAM's relay to own
// and pixels are the only honest recording of one. VP9 in WebM where the
// operator's ffmpeg can encode it, H.264 in MP4 otherwise; the API states
// which in the response's Content-Type, and nothing here needs to know. So
// there is nothing to interpret: the browser's own decoder plays it, and this
// component's job is to make a <video> element obey the same transport the
// other two stages obey.
//
// WHY THE BYTES ARE FETCHED RATHER THAN PUT IN src. The recording endpoint is
// behind the same bearer token as every other admin route, and a <video src>
// carries no Authorization header. Fetching to a blob is what lets the token
// travel; the object URL is revoked on unmount so a long audit session does not
// pin every recording it looked at in memory.
//
// The cost is that the whole artifact downloads before playback starts, which
// is why the agent caps a single recording (four hours) and the API serves the
// file with its index at the front. Range-based streaming would need the token
// somewhere a media element can send it, which is a bigger change than this
// screen is worth today.
export function VideoStage({ recordingId, playing, speed, seekToken, seekTo, onProgress, onDuration, onError }) {
  const videoRef = useRef(null)
  const [src, setSrc] = useState(null)
  const [failure, setFailure] = useState(null)

  // The callbacks are held in a ref rather than listed as dependencies below.
  //
  // This is not tidiness. Callers pass inline arrows (onError={() => ...}),
  // so their identity changes on every render; listing them would re-run the
  // fetch effect each time, and its cleanup revokes the object URL the
  // <video> element is still loading from. Observed exactly that: the
  // artifact was requested four times over and the element never got past
  // readyState 0, because every new render pulled the blob out from under it.
  const cbRef = useRef({ onProgress, onDuration, onError })
  useEffect(() => {
    cbRef.current = { onProgress, onDuration, onError }
  }, [onProgress, onDuration, onError])

  // Load the artifact once per recording, and only once.
  useEffect(() => {
    if (!recordingId) return undefined
    let disposed = false
    let objectUrl = null

    ;(async () => {
      try {
        const token = getAccessToken()
        const res = await fetch(`${API_BASE_URL}/api/v1/pam/admin/recordings/${recordingId}/video`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        if (!res.ok) throw new Error(`The recording could not be loaded (HTTP ${res.status}).`)
        const blob = await res.blob()
        if (disposed) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      } catch (err) {
        if (disposed) return
        setFailure(err?.message || 'The recording could not be loaded.')
        cbRef.current.onError?.(err)
      }
    })()

    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [recordingId])

  // The transport drives the element, not the other way round, so play/pause
  // stays consistent with the terminal and rrweb stages.
  useEffect(() => {
    const el = videoRef.current
    if (!el || !src) return
    if (playing) {
      // A rejected play() is normal (autoplay policy, or the element was
      // disposed mid-promise) and must not be an unhandled rejection.
      el.play().catch(() => cbRef.current.onError?.(new Error('playback was blocked by the browser')))
    } else {
      el.pause()
    }
  }, [playing, src])

  useEffect(() => {
    const el = videoRef.current
    if (el) el.playbackRate = speed || 1
  }, [speed, src])

  // seekToken changes even when seekTo does not, so restarting to 0 from 0
  // still rewinds. Same contract as RrwebStage.
  //
  // The TOKEN is the trigger and seekTo is only its payload, which is why the
  // target is read from a ref instead of being a dependency. It has to be this
  // way round: the transport's `t` is fed BACK from this element's own
  // timeupdate events, so listing seekTo here made every progress tick write
  // currentTime into the element again. Each of those writes is a seek that
  // flushes the decoder, and an eight-second capture crawled forward at about
  // a twentieth of real time while reporting itself as playing. Measured in
  // the console against a real desktop capture, not reasoned about.
  const seekToRef = useRef(seekTo)
  seekToRef.current = seekTo
  useEffect(() => {
    const el = videoRef.current
    if (!el || !src) return
    const target = seekToRef.current
    if (Number.isFinite(target)) el.currentTime = Math.max(0, target)
  }, [seekToken, src])

  if (failure) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="max-w-sm text-center text-xs leading-relaxed text-ink-500">{failure}</p>
      </div>
    )
  }

  if (!src) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-xs text-ink-500">Loading the session recording…</p>
      </div>
    )
  }

  return (
    <div className="flex h-full items-center justify-center bg-black">
      <video
        ref={videoRef}
        src={src}
        className="max-h-full max-w-full"
        // No controls: the player's own transport is the control surface, and
        // two sets of buttons that can disagree is worse than one.
        controls={false}
        playsInline
        muted
        onLoadedMetadata={(e) => cbRef.current.onDuration?.(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => cbRef.current.onProgress?.(e.currentTarget.currentTime || 0)}
        onEnded={() => cbRef.current.onProgress?.(videoRef.current?.duration || 0)}
      />
    </div>
  )
}
