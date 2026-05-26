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
}

export type StoryStepKind =
  | 'narration'
  | 'role_action'
  | 'discussion'
  | 'voting'
  | 'night_resolve'
  | 'day_resolve'
  | 'pause'
  | 'branch'
  | 'end';

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
  superseded_by_id: string | null;
  entry_step_id: string | null;
  created_at: string;
  updated_at: string;
  settings: StorySettings | null;
  steps: StoryStep[];
  transitions: StoryTransition[];
}

// ============================================================================
// Write payloads
// ============================================================================

export interface StoryCreatePayload {
  slug: string;
  name: string;
  description?: string;
  settings?: Partial<StorySettings>;
}

export interface StoryUpdatePayload {
  name?: string;
  description?: string;
  is_active?: boolean;
  is_obsolete?: boolean;
  entry_step_id?: string;
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
}

export interface StoryNarrationCueUpdatePayload {
  sort_order?: number;
  trigger_id?: string | null;
  unset_trigger?: boolean;
  pause_before_ms?: number;
  pause_after_ms?: number;
  override_text?: string | null;
  override_duration_ms?: number | null;
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

  // Export / Import
  export: (id: string) => httpClient.get<unknown>(`${BASE}/${id}/export`),

  import: (payload: unknown, overrideSlug?: string) =>
    httpClient.post<StoryReadFull>(`${BASE}/import`, {
      payload,
      override_slug: overrideSlug,
    }),
};
