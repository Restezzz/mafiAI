/**
 * API-клиент для admin Story Engine endpoints.
 *
 * См. backend/api/routers/admin_stories.py для списка endpoints.
 * Все запросы гейтированы require_admin (401 → redirect to /auth, 403 →
 * banner "Доступ только для администраторов" из getApiErrorMessage).
 */
import httpClient from './httpClient';

// ============================================================================
// Read models (mirror backend/schemas/story.py)
// ============================================================================

export interface StorySettings {
  inter_cue_pause_seconds: string;          // Decimal сериализуется как string
  timer_multiplier_default: string;
  karaoke_enabled: boolean;
}

export interface StoryNarrationCue {
  id: string;
  sort_order: number;
  trigger_id: string | null;
  trigger_slug: string | null;
  pause_before_ms: number;
  pause_after_ms: number;
  override_text: string | null;
  override_duration_ms: number | null;
  // Фича 1: ключ варианта произношения имени, вставляемого между фразами.
  name_variant_key: string | null;
}

export type StoryStepKind =
  | 'narration'
  | 'role_action'
  | 'discussion'
  | 'voting'
  | 'night_resolve'
  | 'day_resolve'
  | 'branch'
  | 'end'
  | 'names'
  | 'roles';

// ============================================================================
// Images / cover crop (фичи 2, 3)
// ============================================================================

export interface ImageRead {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
}

export interface CoverCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ============================================================================
// Name variants (фича 1)
// ============================================================================

export interface StoryName {
  id: string;
  key: string;
  display_name: string;
  sort_order: number;
  base_audio_file_id: string | null;
  base_audio_url: string | null;
  base_audio_filename: string | null;
}

export interface StoryNameVariantAsset {
  story_name_id: string;
  display_name: string;
  audio_file_id: string | null;
  audio_url: string | null;
  audio_filename: string | null;
}

export interface StoryNameVariant {
  id: string;
  key: string;
  label: string;
  sort_order: number;
  assets: StoryNameVariantAsset[];
}

// ============================================================================
// Role overrides (фича 2)
// ============================================================================

export interface RoleCatalogItem {
  slug: string;
  name: string;
  team: string;
}

export interface StoryRoleOverride {
  id: string;
  role_slug: string;
  display_name: string | null;
  card_front_image_id: string | null;
  card_front_url: string | null;
  card_back_image_id: string | null;
  card_back_url: string | null;
}

export interface StoryStep {
  id: string;
  slug: string;
  kind: StoryStepKind;
  label: string;
  payload: Record<string, unknown>;
  position_x: number;
  position_y: number;
  cues: StoryNarrationCue[];
}

export interface StoryTransition {
  id: string;
  from_step_id: string;
  to_step_id: string;
  condition: Record<string, unknown> | null;
  priority: number;
}

export interface StoryListItem {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string | null;
  is_active: boolean;
  is_obsolete: boolean;
  /**
   * Этап 6.6: если true — CueListEditor показывает только
   * triggers этого сюжета (без global namespace).
   */
  use_only_own_triggers: boolean;
  superseded_by_id: string | null;
  created_at: string;
  updated_at: string;
  steps_count: number;
  active_sessions_count: number;
}

export interface StoryListResponse {
  stories: StoryListItem[];
}

export interface StoryReadFull {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string | null;
  is_active: boolean;
  is_obsolete: boolean;
  /**
   * Этап 6.6: если true — CueListEditor показывает только
   * triggers этого сюжета (без global namespace).
   */
  use_only_own_triggers: boolean;
  superseded_by_id: string | null;
  entry_step_id: string | null;
  created_at: string;
  updated_at: string;
  settings: StorySettings | null;
  steps: StoryStep[];
  transitions: StoryTransition[];
  // Фича 3: обложка сюжета для голосования.
  cover_image_id: string | null;
  cover_url: string | null;
  cover_crop: CoverCrop | null;
  // Имена пер-сюжет: собственный набор имён сюжета.
  names: StoryName[];
  // Фичи 1, 2: варианты имён и переопределения ролей.
  name_variants: StoryNameVariant[];
  role_overrides: StoryRoleOverride[];
}

// ============================================================================
// Write payloads
// ============================================================================

export interface StoryCreatePayload {
  slug: string;
  name: string;
  description?: string;
  settings?: Partial<StorySettings>;
  cover_image_id?: string | null;
  cover_crop?: CoverCrop | null;
}

export interface StoryUpdatePayload {
  name?: string;
  description?: string;
  is_active?: boolean;
  is_obsolete?: boolean;
  use_only_own_triggers?: boolean;
  entry_step_id?: string;
  cover_image_id?: string | null;
  cover_crop?: CoverCrop | null;
  unset_cover?: boolean;
}

export interface StoryNameCreatePayload {
  key: string;
  display_name: string;
  sort_order?: number;
  base_audio_file_id?: string | null;
}

export interface StoryNameUpdatePayload {
  display_name?: string;
  sort_order?: number;
  base_audio_file_id?: string | null;
  unset_base_audio?: boolean;
}

export interface StoryNameVariantCreatePayload {
  key: string;
  label?: string;
  sort_order?: number;
}

export interface StoryNameVariantUpdatePayload {
  label?: string;
  sort_order?: number;
}

export interface StoryNameVariantAssetUpdatePayload {
  audio_file_id?: string | null;
  unset_audio?: boolean;
}

export interface StoryRoleOverrideCreatePayload {
  role_slug: string;
  display_name?: string | null;
  card_front_image_id?: string | null;
  card_back_image_id?: string | null;
}

export interface StoryRoleOverrideUpdatePayload {
  display_name?: string | null;
  unset_display_name?: boolean;
  card_front_image_id?: string | null;
  unset_card_front?: boolean;
  card_back_image_id?: string | null;
  unset_card_back?: boolean;
}

export interface StoryStepCreatePayload {
  slug: string;
  kind: StoryStepKind;
  label?: string;
  payload?: Record<string, unknown>;
  position_x?: number;
  position_y?: number;
}

export interface StoryStepUpdatePayload {
  slug?: string;
  kind?: StoryStepKind;
  label?: string;
  payload?: Record<string, unknown>;
  position_x?: number;
  position_y?: number;
}

export interface StoryTransitionCreatePayload {
  from_step_id: string;
  to_step_id: string;
  condition?: Record<string, unknown> | null;
  priority?: number;
}

export interface StoryTransitionUpdatePayload {
  from_step_id?: string;
  to_step_id?: string;
  condition?: Record<string, unknown> | null;
  unset_condition?: boolean;
  priority?: number;
}

export interface StoryNarrationCueCreatePayload {
  sort_order: number;
  trigger_id?: string | null;
  pause_before_ms?: number;
  pause_after_ms?: number;
  override_text?: string | null;
  override_duration_ms?: number | null;
  name_variant_key?: string | null;
}

export interface StoryNarrationCueUpdatePayload {
  sort_order?: number;
  trigger_id?: string | null;
  unset_trigger?: boolean;
  pause_before_ms?: number;
  pause_after_ms?: number;
  override_text?: string | null;
  override_duration_ms?: number | null;
  name_variant_key?: string | null;
  unset_name_variant?: boolean;
}

// ============================================================================
// Client
// ============================================================================

const BASE = '/admin/stories';

export const adminStoriesApi = {
  // Stories
  list: (params?: { include_obsolete?: boolean; include_inactive?: boolean }) =>
    httpClient.get<StoryListResponse>(BASE, { params }),

  get: (id: string) => httpClient.get<StoryReadFull>(`${BASE}/${id}`),

  create: (payload: StoryCreatePayload) =>
    httpClient.post<StoryReadFull>(BASE, payload),

  update: (id: string, payload: StoryUpdatePayload) =>
    httpClient.put<StoryReadFull>(`${BASE}/${id}`, payload),

  delete: (id: string) => httpClient.delete<void>(`${BASE}/${id}`),

  duplicate: (id: string) =>
    httpClient.post<StoryReadFull>(`${BASE}/${id}/duplicate`),

  // Settings
  updateSettings: (id: string, payload: Partial<StorySettings>) =>
    httpClient.put<StorySettings>(`${BASE}/${id}/settings`, payload),

  // Steps
  createStep: (storyId: string, payload: StoryStepCreatePayload) =>
    httpClient.post<StoryStep>(`${BASE}/${storyId}/steps`, payload),

  updateStep: (storyId: string, stepId: string, payload: StoryStepUpdatePayload) =>
    httpClient.put<StoryStep>(`${BASE}/${storyId}/steps/${stepId}`, payload),

  deleteStep: (storyId: string, stepId: string) =>
    httpClient.delete<void>(`${BASE}/${storyId}/steps/${stepId}`),

  // Bulk-обновление позиций нод (drag-and-drop в node-редакторе, этап 4).
  // Без этого endpoint каждое движение мыши превращалось бы в N HTTP-запросов.
  updateLayout: (
    storyId: string,
    positions: Array<{ step_id: string; position_x: number; position_y: number }>,
  ) =>
    httpClient.patch<{ updated: number }>(
      `${BASE}/${storyId}/layout`,
      { positions },
    ),

  // Transitions
  createTransition: (storyId: string, payload: StoryTransitionCreatePayload) =>
    httpClient.post<StoryTransition>(`${BASE}/${storyId}/transitions`, payload),

  updateTransition: (storyId: string, transitionId: string, payload: StoryTransitionUpdatePayload) =>
    httpClient.put<StoryTransition>(`${BASE}/${storyId}/transitions/${transitionId}`, payload),

  deleteTransition: (storyId: string, transitionId: string) =>
    httpClient.delete<void>(`${BASE}/${storyId}/transitions/${transitionId}`),

  // Cues
  createCue: (storyId: string, stepId: string, payload: StoryNarrationCueCreatePayload) =>
    httpClient.post<StoryNarrationCue>(`${BASE}/${storyId}/steps/${stepId}/cues`, payload),

  updateCue: (storyId: string, cueId: string, payload: StoryNarrationCueUpdatePayload) =>
    httpClient.put<StoryNarrationCue>(`${BASE}/${storyId}/cues/${cueId}`, payload),

  deleteCue: (storyId: string, cueId: string) =>
    httpClient.delete<void>(`${BASE}/${storyId}/cues/${cueId}`),

  reorderCues: (storyId: string, stepId: string, cueIds: string[]) =>
    httpClient.post<StoryNarrationCue[]>(
      `${BASE}/${storyId}/steps/${stepId}/cues/reorder`,
      { cue_ids: cueIds },
    ),

  // Images (фичи 2, 3)
  uploadImage: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return httpClient.post<ImageRead>(`/admin/images`, fd);
  },
  listImages: () => httpClient.get<{ images: ImageRead[] }>(`/admin/images`),
  deleteImage: (imageId: string) =>
    httpClient.delete<void>(`/admin/images/${imageId}`),

  // Story names (имена пер-сюжет): базовый набор имён сюжета
  createStoryName: (storyId: string, payload: StoryNameCreatePayload) =>
    httpClient.post<StoryName>(`${BASE}/${storyId}/names`, payload),
  updateStoryName: (
    storyId: string,
    nameId: string,
    payload: StoryNameUpdatePayload,
  ) =>
    httpClient.put<StoryName>(`${BASE}/${storyId}/names/${nameId}`, payload),
  deleteStoryName: (storyId: string, nameId: string) =>
    httpClient.delete<void>(`${BASE}/${storyId}/names/${nameId}`),

  // Name variants (фича 1)
  createNameVariant: (storyId: string, payload: StoryNameVariantCreatePayload) =>
    httpClient.post<StoryNameVariant>(`${BASE}/${storyId}/name-variants`, payload),
  updateNameVariant: (
    storyId: string,
    variantId: string,
    payload: StoryNameVariantUpdatePayload,
  ) =>
    httpClient.put<StoryNameVariant>(
      `${BASE}/${storyId}/name-variants/${variantId}`,
      payload,
    ),
  deleteNameVariant: (storyId: string, variantId: string) =>
    httpClient.delete<void>(`${BASE}/${storyId}/name-variants/${variantId}`),
  setNameVariantAsset: (
    storyId: string,
    variantId: string,
    storyNameId: string,
    payload: StoryNameVariantAssetUpdatePayload,
  ) =>
    httpClient.put<StoryNameVariantAsset>(
      `${BASE}/${storyId}/name-variants/${variantId}/assets/${storyNameId}`,
      payload,
    ),

  // Role overrides (фича 2)
  listRoles: () => httpClient.get<{ roles: RoleCatalogItem[] }>(`/admin/roles`),
  createRoleOverride: (storyId: string, payload: StoryRoleOverrideCreatePayload) =>
    httpClient.post<StoryRoleOverride>(`${BASE}/${storyId}/role-overrides`, payload),
  updateRoleOverride: (
    storyId: string,
    overrideId: string,
    payload: StoryRoleOverrideUpdatePayload,
  ) =>
    httpClient.put<StoryRoleOverride>(
      `${BASE}/${storyId}/role-overrides/${overrideId}`,
      payload,
    ),
  deleteRoleOverride: (storyId: string, overrideId: string) =>
    httpClient.delete<void>(`${BASE}/${storyId}/role-overrides/${overrideId}`),

  // Export / Import
  export: (id: string) => httpClient.get<unknown>(`${BASE}/${id}/export`),

  import: (payload: unknown, overrideSlug?: string) =>
    httpClient.post<StoryReadFull>(`${BASE}/import`, {
      payload,
      override_slug: overrideSlug,
    }),
};
