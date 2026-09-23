import { getResolvedVideoModelId, type VideoModelConfig } from '@/lib/flyreq-models';

export type VideoTaskStatus = 'queued' | '排队中' | 'processing' | 'completed' | 'failed' | 'cancelled' | 'expired';

export interface VideoTaskResponse {
  id: string;
  status: VideoTaskStatus;
  result?: { videoUrl?: string; upstreamTaskId?: string };
  error?: string;
  createdAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface CreateVideoTaskInput {
  model: VideoModelConfig;
  prompt: string;
  resolution: number;
  size: string;
  aspectRatio: string;
  seconds: number;
  referenceImages: File[];
  referenceVideos: File[];
  referenceAudios: File[];
  referenceImageUrls: string[];
  referenceVideoUrls: string[];
  referenceAudioUrls: string[];
  promptVariants?: string[];
}

/**
 * 构建视频任务 multipart 请求体。
 * @param input 模型、提示词、视频参数和参考附件。
 * @param parallelCount 本次需要创建的独立视频任务数量。
 * @returns 可直接提交给视频任务端点的表单数据。
 */
function buildVideoTaskFormData(input: CreateVideoTaskInput, parallelCount: number): FormData {
  const formData = new FormData();
  formData.set('apiKey', input.model.apiKey);
  formData.set('baseUrl', input.model.baseUrl);
  formData.set('protocol', input.model.protocol);
  formData.set('model', getResolvedVideoModelId(input.model));
  formData.set('modelName', input.model.name);
  formData.set('prompt', input.prompt);
  formData.set('resolution', String(input.resolution));
  formData.set('size', input.size);
  formData.set('aspectRatio', input.aspectRatio);
  formData.set('seconds', String(input.seconds));
  formData.set('parallelCount', String(parallelCount));
  formData.set('promptVariants', JSON.stringify(input.promptVariants || []));
  input.referenceImages.forEach(file => formData.append('reference_images', file, file.name));
  input.referenceVideos.forEach(file => formData.append('reference_videos', file, file.name));
  input.referenceAudios.forEach(file => formData.append('reference_audios', file, file.name));
  input.referenceImageUrls.forEach(url => formData.append('reference_image_urls', url));
  input.referenceVideoUrls.forEach(url => formData.append('reference_video_urls', url));
  input.referenceAudioUrls.forEach(url => formData.append('reference_audio_urls', url));
  return formData;
}

/**
 * 从失败响应中提取可展示错误。
 * @param response 后端 HTTP 响应。
 * @returns 始终抛出包含后端错误文本的异常。
 */
async function throwVideoTaskError(response: Response): Promise<never> {
  const data = await response.json().catch(() => null) as { error?: string } | null;
  throw new Error(data?.error || `视频任务请求失败: ${response.status}`);
}

/**
 * 创建一个视频生成任务并上传参考附件。
 * @param input 模型、提示词、参数和参考附件。
 * @returns 后端创建的视频任务快照，包含任务标识、服务端创建时间和初始耗时。
 */
export async function createVideoTask(input: CreateVideoTaskInput): Promise<VideoTaskResponse> {
  const response = await fetch('/api/flyreq/video-tasks', { method: 'POST', body: buildVideoTaskFormData(input, 1) });
  if (!response.ok) return throwVideoTaskError(response);
  const data = await response.json() as VideoTaskResponse;
  if (!data.id) throw new Error('后端未返回视频任务 ID');
  return data;
}

/**
 * 原子创建一组参数相同的独立视频生成任务。
 * @param input 模型、提示词、视频参数和参考附件。
 * @param parallelCount 需要创建的视频任务数量，范围为 1 至 20。
 * @returns 按批次序号排列的视频任务初始快照。
 */
export async function createVideoTasks(input: CreateVideoTaskInput, parallelCount: number): Promise<VideoTaskResponse[]> {
  const response = await fetch('/api/flyreq/video-tasks', { method: 'POST', body: buildVideoTaskFormData(input, parallelCount) });
  if (!response.ok) return throwVideoTaskError(response);
  const data = await response.json() as { tasks?: VideoTaskResponse[] };
  if (!Array.isArray(data.tasks) || data.tasks.length !== parallelCount || data.tasks.some(task => !task.id)) {
    throw new Error('后端未返回完整的视频任务列表');
  }
  return data.tasks;
}

/**
 * 查询视频任务当前状态。
 * @param taskId 后端视频任务标识。
 * @returns 视频任务快照。
 */
export async function getVideoTask(taskId: string): Promise<VideoTaskResponse> {
  const response = await fetch(`/api/flyreq/video-tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
  if (!response.ok && response.status !== 404) return throwVideoTaskError(response);
  return response.json() as Promise<VideoTaskResponse>;
}

/**
 * 确认视频结果已在浏览器完成缓存。
 * @param taskId 后端视频任务标识。
 * @returns 无返回值。
 */
export async function acknowledgeVideoTask(taskId: string): Promise<void> {
  await fetch(`/api/flyreq/video-tasks/${encodeURIComponent(taskId)}/ack`, { method: 'POST' });
}

/**
 * 取消排队中或处理中的视频任务。
 * @param taskId 后端视频任务标识。
 * @returns 后端确认后的取消任务快照。
 */
export async function cancelVideoTask(taskId: string): Promise<VideoTaskResponse> {
  const response = await fetch(`/api/flyreq/video-tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
  if (!response.ok) return throwVideoTaskError(response);
  return response.json() as Promise<VideoTaskResponse>;
}
