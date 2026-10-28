import type { ErrorKind } from '@shared/types'

/**
 * Classifies download/analysis errors so the retry policy can distinguish
 * transient failures (network blips, rate limiting, server hiccups — retried
 * with exponential backoff) from permanent ones (removed/private videos,
 * invalid URLs — terminal, never retried automatically).
 */
export interface ClassifiedError {
  kind: ErrorKind
  /** Human-friendly reason to show the user. */
  message: string
  /** Raw error text the message was derived from (used for diagnostics). */
  raw: string
}

/**
 * Distinct failure codes used across the audio download pipeline so every
 * failure mode is diagnosed and reported separately (never one generic
 * message for all errors).
 */
export const AudioFailure = {
  /** The source offers no audio stream at all (audio-only or combined). */
  AUDIO_STREAM_NOT_FOUND: 'AUDIO_STREAM_NOT_FOUND',
  /** yt-dlp could not fetch any audio-bearing stream. */
  AUDIO_DOWNLOAD_FAILED: 'AUDIO_DOWNLOAD_FAILED',
  /** The downloaded file is missing, empty or unreasonably small. */
  AUDIO_FILE_EMPTY: 'AUDIO_FILE_EMPTY',
  /** The stream URL responded with a non-media payload (HTML/JSON/text/error page). */
  AUDIO_DOWNLOAD_INVALID: 'AUDIO_DOWNLOAD_INVALID',
  /** The downloaded file exists but contains no audio stream (e.g. video-only). */
  AUDIO_FILE_INVALID: 'AUDIO_FILE_INVALID',
  /** FFprobe/FFmpeg could not inspect the input file. */
  FFPROBE_FAILED: 'FFPROBE_FAILED',
  /** FFmpeg conversion failed. */
  FFMPEG_FAILED: 'FFMPEG_FAILED',
  /** The produced MP3 failed post-conversion validation. */
  MP3_VALIDATION_FAILED: 'MP3_VALIDATION_FAILED'
} as const

/**
 * Typed failure that carries a machine-readable code so the queue can route
 * audio failures to the correct retry policy and show precise technical
 * details instead of a single generic message.
 */
export class DownloadFailure extends Error {
  code: string
  details?: string
  constructor(code: string, message: string, details?: string) {
    super(message)
    this.name = 'DownloadFailure'
    this.code = code
    this.details = details
  }
}

function isTemporary(text: string): boolean {
  return (
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('the read operation timed out') ||
    text.includes('connection reset') ||
    text.includes('connection aborted') ||
    text.includes('connection closed') ||
    text.includes('connection error') ||
    text.includes('network') ||
    text.includes('broken pipe') ||
    text.includes('reset by peer') ||
    text.includes('socket') ||
    text.includes('server error') ||
    text.includes('http error 401') ||
    text.includes('http error 403') ||
    text.includes('http error 500') ||
    text.includes('http error 502') ||
    text.includes('http error 503') ||
    text.includes('http error 504') ||
    text.includes('http error 429') ||
    text.includes('forbidden') ||
    text.includes('too many requests') ||
    text.includes('rate limit') ||
    text.includes('temporarily unavailable') ||
    text.includes('server busy') ||
    text.includes('overloaded') ||
    text.includes('internal server error') ||
    text.includes('unexpected end of file') ||
    text.includes('unexpected end-of-file') ||
    text.includes('eof') ||
    text.includes('download interrupted') ||
    text.includes('requested format is not available') ||
    (text.includes('unable to download') && !text.includes('http error 404')) ||
    text.includes('expired') ||
    text.includes('signature') ||
    text.includes('metadata') ||
    text.includes('could not parse') ||
    text.includes('failed to parse') ||
    text.includes('failed to extract') ||
    text.includes('failed to analyze') ||
    text.includes('unable to extract') ||
    text.includes('extractor error') ||
    text.includes('no webpage') ||
    text.includes('no formats found') ||
    text.includes('unable to extract initial data') ||
    text.includes('sleeping') ||
    text.includes('backing off') ||
    text.includes('backoff') ||
    text.includes('retry') ||
    text.includes('no space left') ||
    text.includes('enospc') ||
    text.includes('disk full')
  )
}

function isUnavailable(text: string): boolean {
  return (
    text.includes('video unavailable') ||
    text.includes('is unavailable') ||
    text.includes('is not available') ||
    text.includes('has been removed') ||
    text.includes('no longer available') ||
    text.includes('removed by the user') ||
    text.includes('private video') ||
    text.includes('this video is private') ||
    text.includes('requires sign in') ||
    text.includes('sign in to confirm') ||
    text.includes('requires a login') ||
    text.includes('member-only') ||
    text.includes('membership') ||
    text.includes('music premium') ||
    text.includes('account required') ||
    text.includes('login required') ||
    text.includes('drm') ||
    text.includes('audio unavailable') ||
    text.includes('copyright') ||
    text.includes('blocked it in your country') ||
    text.includes('blocked in your country') ||
    text.includes('not available in your country') ||
    text.includes('made this video available in your country') ||
    text.includes('unavailable in your region') ||
    text.includes('geo-blocked') ||
    text.includes('geo restricted') ||
    text.includes('no such video') ||
    text.includes('video not found') ||
    text.includes('http error 404') ||
    text.includes('invalid url') ||
    text.includes('unsupported url') ||
    text.includes('unknown url type') ||
    text.includes('this video contains content from') ||
    text.includes('took down this video') ||
    text.includes('content is not available') ||
    text.includes('video does not exist') ||
    text.includes('invalid video id')
  )
}

function friendlyPermanent(text: string): string {
  if (text.includes('drm')) {
    return 'This video is DRM protected and cannot be downloaded.'
  }
  if (text.includes('audio unavailable') || text.includes('no audio')) {
    return 'This item has no available audio stream.'
  }
  if (
    text.includes('private') ||
    text.includes('requires sign in') ||
    text.includes('sign in to confirm') ||
    text.includes('requires a login') ||
    text.includes('member-only') ||
    text.includes('membership') ||
    text.includes('music premium') ||
    text.includes('account required') ||
    text.includes('login required')
  ) {
    return 'This video is private or requires sign-in.'
  }
  if (text.includes('copyright') || text.includes('blocked in your country') || text.includes('blocked it in your country') || text.includes('contains content from')) {
    return 'This video is unavailable due to a copyright or region restriction.'
  }
  if (text.includes('not available in your country') || text.includes('made this video available in your country') || text.includes('unavailable in your region') || text.includes('geo')) {
    return 'This video is unavailable in your region.'
  }
  if (text.includes('invalid url') || text.includes('unsupported url') || text.includes('unknown url type')) {
    return 'The link is invalid or not supported.'
  }
  if (text.includes('video not found') || text.includes('no such video') || text.includes('video does not exist') || text.includes('http error 404')) {
    return 'This item could not be found.'
  }
  return 'This video is unavailable or has been removed.'
}

function friendlyTemporary(text: string): string {
  if (text.includes('no space left') || text.includes('enospc') || text.includes('disk full')) {
    return 'Insufficient storage space on the destination drive.'
  }
  if (text.includes('expired') || text.includes('signature')) {
    return 'The stream URL expired. Re-analyzing and retrying...'
  }
  if (text.includes('metadata') || text.includes('could not parse') || text.includes('failed to parse') || text.includes('failed to extract') || text.includes('failed to analyze') || text.includes('unable to extract') || text.includes('no webpage') || text.includes('no formats found')) {
    return 'Failed to read media metadata. Re-analyzing and retrying...'
  }
  if (text.includes('http error 429') || text.includes('too many requests') || text.includes('rate limit')) {
    return 'The source is rate limiting requests. Retrying shortly...'
  }
  if (text.includes('timed out') || text.includes('timeout') || text.includes('socket')) {
    return 'Connection timed out. Retrying shortly...'
  }
  if (text.includes('server error') || text.includes('http error 5') || text.includes('temporarily unavailable') || text.includes('overloaded')) {
    return 'The source server is temporarily unavailable. Retrying shortly...'
  }
  if (text.includes('connection') || text.includes('network') || text.includes('broken pipe') || text.includes('reset by peer') || text.includes('eof')) {
    return 'Network connection problem. Retrying shortly...'
  }
  if (text.includes('http error 401') || text.includes('http error 403') || text.includes('forbidden')) {
    return 'The source blocked this request (HTTP 403). Re-analyzing and retrying...'
  }
  if (text.includes('requested format is not available') || text.includes('unable to download')) {
    return 'The requested format could not be fetched. Re-analyzing and retrying...'
  }
  return 'Temporary failure. Retrying shortly...'
}

export function classifyError(input: unknown, details = ''): ClassifiedError {
  const raw = input instanceof Error ? input.message : String(input ?? '')
  const text = `${raw}\n${details}`.toLowerCase()
  // Check temporary FIRST so transient extraction/network errors are never
  // misclassified as permanent when the raw output happens to also contain
  // words like "unavailable" or "not found" in passing.
  if (isTemporary(text)) {
    return { kind: 'temporary', message: friendlyTemporary(text), raw }
  }
  if (isUnavailable(text)) {
    return { kind: 'permanent', message: friendlyPermanent(text), raw }
  }
  return { kind: 'unknown', message: raw || 'Unable to download this file.', raw }
}

/** True when the friendly message maps to the "removed/unavailable" bucket. */
export function isPermanentUnavailable(kind: ErrorKind): boolean {
  return kind === 'permanent'
}

/**
 * True when a failure indicates the previously analyzed metadata/stream URL is
 * stale (HTTP 403, expired/signature, format vanished). The retry policy then
 * invalidates the analyze cache so the next attempt re-analyzes from scratch.
 */
export function isStaleAnalysisFailure(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('http error 403') ||
    t.includes('forbidden') ||
    t.includes('expired') ||
    t.includes('signature') ||
    t.includes('requested format is not available') ||
    t.includes('unable to extract initial data') ||
    t.includes('no formats found')
  )
}

/**
 * True when a download error indicates the source has no usable audio stream
 * (rather than a transient network problem). Used for audio-kind tasks: the
 * item is re-analyzed exactly once with fresh stream info before it is marked
 * terminal as "no compatible audio stream".
 */
export function isAudioUnavailableError(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('no audio') ||
    t.includes('has no audio') ||
    t.includes('audio stream') ||
    t.includes('audio format') ||
    t.includes('requested format is not available')
  )
}
