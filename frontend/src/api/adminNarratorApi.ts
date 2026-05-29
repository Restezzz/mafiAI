import httpClient from './httpClient';
import {
  AudioFile,
  CompositeSegment,
  CompositeSegmentCreatePayload,
  CompositeSegmentUpdatePayload,
  CompositeTemplate,
  CompositeTemplateCreatePayload,
  CompositeTemplateUpdatePayload,
  ListTriggersParams,
  NameAsset,
  NameAssetUpdatePayload,
  PlaceholderInfo,
  Trigger,
  TriggerCreatePayload,
  TriggerUpdatePayload,
  Variant,
  VariantCreatePayload,
  VariantUpdatePayload,
} from '../types/narrator';

// Axios baseURL = `${API_BASE_URL}/api`, поэтому пути относительны корня /api.
const BASE = '/admin/narrator';

export const adminNarratorApi = {
  // --- Triggers ---
  listTriggers: (params?: ListTriggersParams) =>
    httpClient.get<{ triggers: Trigger[] }>(`${BASE}/triggers`, {
      params: {
        story_id: params?.story_id,
        // axios скипает undefined, но false-параметры передаёт как 'false' —
        // явно конвертируем в строку 'true', а если false/undefined — не
        // включаем в querystring совсем (default backend = false).
        ...(params?.include_global ? { include_global: 'true' } : {}),
      },
    }),
  getTrigger: (id: string) => httpClient.get<Trigger>(`${BASE}/triggers/${id}`),
  createTrigger: (payload: TriggerCreatePayload) =>
    httpClient.post<Trigger>(`${BASE}/triggers`, payload),
  updateTrigger: (id: string, payload: TriggerUpdatePayload) =>
    httpClient.put<Trigger>(`${BASE}/triggers/${id}`, payload),
  deleteTrigger: (id: string) => httpClient.delete(`${BASE}/triggers/${id}`),

  // --- Variants ---
  createVariant: (triggerId: string, payload: VariantCreatePayload) =>
    httpClient.post<Variant>(`${BASE}/triggers/${triggerId}/variants`, payload),
  updateVariant: (id: string, payload: VariantUpdatePayload) =>
    httpClient.put<Variant>(`${BASE}/variants/${id}`, payload),
  deleteVariant: (id: string) => httpClient.delete(`${BASE}/variants/${id}`),

  // --- Composite templates ---
  createTemplate: (triggerId: string, payload: CompositeTemplateCreatePayload) =>
    httpClient.post<CompositeTemplate>(
      `${BASE}/triggers/${triggerId}/composite-templates`,
      payload,
    ),
  updateTemplate: (id: string, payload: CompositeTemplateUpdatePayload) =>
    httpClient.put<CompositeTemplate>(`${BASE}/composite-templates/${id}`, payload),
  deleteTemplate: (id: string) => httpClient.delete(`${BASE}/composite-templates/${id}`),

  // --- Composite segments ---
  createSegment: (templateId: string, payload: CompositeSegmentCreatePayload) =>
    httpClient.post<CompositeSegment>(
      `${BASE}/composite-templates/${templateId}/segments`,
      payload,
    ),
  updateSegment: (id: string, payload: CompositeSegmentUpdatePayload) =>
    httpClient.put<CompositeSegment>(`${BASE}/segments/${id}`, payload),
  deleteSegment: (id: string) => httpClient.delete(`${BASE}/segments/${id}`),

  // --- Audio files ---
  listAudioFiles: () =>
    httpClient.get<{ audio_files: AudioFile[] }>(`${BASE}/audio-files`),
  uploadAudioFile: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return httpClient.post<AudioFile>(`${BASE}/audio-files`, fd);
  },
  deleteAudioFile: (id: string) => httpClient.delete(`${BASE}/audio-files/${id}`),

  // --- Name assets ---
  listNameAssets: () =>
    httpClient.get<{ name_assets: NameAsset[] }>(`${BASE}/name-assets`),
  createNameAsset: (params: { display_name: string; gender: 'm' | 'f'; file: File }) => {
    const fd = new FormData();
    fd.append('display_name', params.display_name);
    fd.append('gender', params.gender);
    fd.append('file', params.file);
    return httpClient.post<NameAsset>(`${BASE}/name-assets`, fd);
  },
  updateNameAsset: (id: string, payload: NameAssetUpdatePayload) =>
    httpClient.put<NameAsset>(`${BASE}/name-assets/${id}`, payload),
  deleteNameAsset: (id: string) => httpClient.delete(`${BASE}/name-assets/${id}`),

  // --- Placeholders catalog ---
  listPlaceholders: () =>
    httpClient.get<{ placeholders: PlaceholderInfo[] }>(`${BASE}/placeholders`),
};
