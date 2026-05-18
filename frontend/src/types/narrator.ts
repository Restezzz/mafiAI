// TypeScript-зеркало схем /api/admin/narrator/* (см. backend/schemas/narrator.py).
// При расхождении — синхронизировать с backend.

export type TriggerKind = 'variant' | 'composite';
export type SegmentKind = 'audio' | 'placeholder';
export type Gender = 'm' | 'f';

export interface AudioFile {
  id: string;
  filename: string;
  url: string;
  duration_ms: number;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by_id: string | null;
}

export interface Variant {
  id: string;
  audio_file_id: string | null;
  audio_url: string | null;
  text: string;
  duration_ms: number | null;
  sort_order: number;
}

export interface CompositeSegment {
  id: string;
  position: number;
  kind: SegmentKind;
  audio_file_id: string | null;
  audio_url: string | null;
  placeholder_key: string | null;
  text_fragment: string;
}

export interface CompositeTemplate {
  id: string;
  label: string | null;
  sort_order: number;
  segments: CompositeSegment[];
}

export interface Trigger {
  id: string;
  slug: string;
  group_key: string;
  label: string;
  description: string | null;
  kind: TriggerKind;
  created_at: string;
  updated_at: string;
  variants: Variant[];
  composite_templates: CompositeTemplate[];
}

export interface NameAsset {
  id: string;
  display_name: string;
  slug: string;
  gender: Gender;
  audio_file_id: string;
  audio_url: string;
}

export interface PlaceholderInfo {
  key: string;
  label: string;
  description: string;
}

// Request bodies

export interface TriggerCreatePayload {
  slug: string;
  group_key: string;
  label: string;
  description?: string | null;
  kind: TriggerKind;
}

export interface TriggerUpdatePayload {
  group_key?: string;
  label?: string;
  description?: string | null;
}

export interface VariantCreatePayload {
  audio_file_id?: string | null;
  text: string;
  duration_ms?: number | null;
  sort_order?: number;
}

export interface VariantUpdatePayload {
  audio_file_id?: string | null;
  text?: string;
  duration_ms?: number | null;
  sort_order?: number;
  unset_audio?: boolean;
}

export interface CompositeTemplateCreatePayload {
  label?: string | null;
  sort_order?: number;
}

export interface CompositeTemplateUpdatePayload {
  label?: string | null;
  sort_order?: number;
}

export interface CompositeSegmentCreatePayload {
  position: number;
  kind: SegmentKind;
  audio_file_id?: string | null;
  placeholder_key?: string | null;
  text_fragment?: string;
}

export interface CompositeSegmentUpdatePayload {
  position?: number;
  kind?: SegmentKind;
  audio_file_id?: string | null;
  placeholder_key?: string | null;
  text_fragment?: string;
  unset_audio?: boolean;
}

export interface NameAssetUpdatePayload {
  display_name?: string;
  gender?: Gender;
  audio_file_id?: string;
}
