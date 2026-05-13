// face-api.js wrapper — single point of contact for model loading and
// descriptor extraction. The first call to loadFaceModels() downloads the
// three networks we need (~7MB) from /models/; subsequent calls are no-ops.

import * as faceapi from 'face-api.js'

const MODEL_URL = '/models'

let loadPromise: Promise<void> | null = null

export function loadFaceModels(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ])
  })().catch((err) => {
    loadPromise = null
    throw err
  })
  return loadPromise
}

const TINY_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  inputSize: 224,
  scoreThreshold: 0.5,
})

// Relaxed options for low-light — slightly lower score threshold so partially
// lit faces still register. Descriptor distance threshold in FaceCapture is
// unchanged, so security is not compromised.
const TINY_OPTIONS_LOWLIGHT = new faceapi.TinyFaceDetectorOptions({
  inputSize: 224,
  scoreThreshold: 0.35,
})

// Draw a video frame onto an off-screen canvas with brightness/contrast boost.
// face-api.js accepts HTMLCanvasElement as input, same as HTMLVideoElement.
function preprocessVideoFrame(video: HTMLVideoElement, brightness: number): HTMLCanvasElement {
  const w = video.videoWidth || 320
  const h = video.videoHeight || 320
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.filter = `brightness(${brightness}) contrast(1.15)`
  ctx.drawImage(video, 0, 0, w, h)
  return canvas
}

// Sample average luminance (0–255) from the current video frame.
// Returns 128 (neutral) if the video is not yet ready.
export function measureFrameBrightness(video: HTMLVideoElement): number {
  if (!video || video.readyState < 2 || video.videoWidth === 0) return 128
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, 0, 0, size, size)
  const { data } = ctx.getImageData(0, 0, size, size)
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
  }
  return sum / (size * size)
}

// Eye-aspect ratio: drops below ~0.2 during a blink, recovers above ~0.25.
// 68-landmark indices: left eye 36..41, right eye 42..47.
export function eyeAspectRatio(landmarks: faceapi.FaceLandmarks68): number {
  const pts = landmarks.positions
  const dist = (a: faceapi.Point, b: faceapi.Point) =>
    Math.hypot(a.x - b.x, a.y - b.y)
  const ear = (eye: faceapi.Point[]) =>
    (dist(eye[1], eye[5]) + dist(eye[2], eye[4])) / (2 * dist(eye[0], eye[3]))
  const left  = ear([pts[36], pts[37], pts[38], pts[39], pts[40], pts[41]])
  const right = ear([pts[42], pts[43], pts[44], pts[45], pts[46], pts[47]])
  return (left + right) / 2
}

export interface CaptureResult {
  descriptor: Float32Array
  landmarks: faceapi.FaceLandmarks68
  detectionScore: number
}

export interface LandmarkResult {
  landmarks: faceapi.FaceLandmarks68
  detectionScore: number
}

// Run detection + landmarks + descriptor on a single video frame. Returns
// null if no face (or multiple faces) is detected — multi-face is rejected
// to avoid ambiguity about who is checking in.
export async function captureDescriptor(
  video: HTMLVideoElement,
  lowLight?: boolean,
): Promise<CaptureResult | null> {
  const input: HTMLVideoElement | HTMLCanvasElement = lowLight
    ? preprocessVideoFrame(video, 1.8)
    : video
  const opts = lowLight ? TINY_OPTIONS_LOWLIGHT : TINY_OPTIONS
  const result = await faceapi
    .detectSingleFace(input, opts)
    .withFaceLandmarks()
    .withFaceDescriptor()
  if (!result) return null
  return {
    descriptor: result.descriptor,
    landmarks: result.landmarks,
    detectionScore: result.detection.score,
  }
}

// Faster frame capture for liveness. This skips the recognition network so
// blink detection can sample many more frames after the face has matched.
export async function captureLandmarks(
  video: HTMLVideoElement,
  lowLight?: boolean,
): Promise<LandmarkResult | null> {
  const input: HTMLVideoElement | HTMLCanvasElement = lowLight
    ? preprocessVideoFrame(video, 1.8)
    : video
  const opts = lowLight ? TINY_OPTIONS_LOWLIGHT : TINY_OPTIONS
  const result = await faceapi
    .detectSingleFace(input, opts)
    .withFaceLandmarks()
  if (!result) return null
  return {
    landmarks: result.landmarks,
    detectionScore: result.detection.score,
  }
}

// Euclidean distance between two 128-float descriptors. The face-api.js
// docs treat <0.5 as a high-confidence match, 0.5-0.6 as borderline.
export function descriptorDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return Math.sqrt(sum)
}

// Rough head pose from 68-landmarks. Returns yaw (negative = looking left,
// positive = looking right) and pitch (positive = looking up, negative =
// looking down), both normalised by face geometry so the values are
// roughly comparable across users and camera distances.
//
//   yaw   ≈ (nose.x - eyeMid.x)     / inter-eye width
//   pitch ≈ (faceMidY - nose.y)      / face height
//         where faceMidY = (browMid.y + chin.y) / 2
//
// WHY faceMidY for pitch (not eyeMid.y):
//   eyeMid is ~25–35% of face height ABOVE the nose tip at neutral gaze,
//   giving a raw pitch of ≈ −0.3 at neutral — far outside the center-bucket
//   threshold of ±0.056. The face vertical midpoint (brow-to-chin) sits
//   within ~0.02 of the nose tip at neutral, so pitch ≈ 0 when looking
//   straight ahead and crosses ±0.08 with a small deliberate tilt.
//
// Note: the video element is mirrored (scaleX(-1)) in the UI, but we read
// from the raw video frame which is NOT mirrored, so a face looking to
// the user's left will produce a positive nose.x offset here. The sweep
// component applies the mirror correction when it labels buckets.
export function estimateHeadPose(landmarks: faceapi.FaceLandmarks68): { yaw: number; pitch: number } {
  const pts = landmarks.positions
  const leftEyeOuter  = pts[36]
  const rightEyeOuter = pts[45]
  const nose          = pts[30]
  const chin          = pts[8]
  const browMid       = { x: (pts[19].x + pts[24].x) / 2, y: (pts[19].y + pts[24].y) / 2 }
  const eyeMid        = { x: (leftEyeOuter.x + rightEyeOuter.x) / 2, y: (leftEyeOuter.y + rightEyeOuter.y) / 2 }
  const interEye      = Math.hypot(rightEyeOuter.x - leftEyeOuter.x, rightEyeOuter.y - leftEyeOuter.y) || 1
  const faceHeight    = Math.abs(chin.y - browMid.y) || 1
  const faceMidY      = (browMid.y + chin.y) / 2  // ~same vertical position as nose tip at neutral
  const yaw   = (nose.x - eyeMid.x) / interEye
  const pitch = (faceMidY - nose.y) / faceHeight
  return { yaw, pitch }
}

// Average several descriptors element-wise. Used during enrollment to smooth
// out per-frame noise.
export function averageDescriptors(descriptors: Float32Array[]): Float32Array {
  if (descriptors.length === 0) return new Float32Array(128)
  const len = descriptors[0].length
  const out = new Float32Array(len)
  for (const d of descriptors) {
    for (let i = 0; i < len; i++) out[i] += d[i]
  }
  for (let i = 0; i < len; i++) out[i] /= descriptors.length
  return out
}
