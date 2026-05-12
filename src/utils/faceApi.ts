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
): Promise<CaptureResult | null> {
  const result = await faceapi
    .detectSingleFace(video, TINY_OPTIONS)
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
): Promise<LandmarkResult | null> {
  const result = await faceapi
    .detectSingleFace(video, TINY_OPTIONS)
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
