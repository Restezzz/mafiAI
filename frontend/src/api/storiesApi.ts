/**
 * Публичный API сюжетов — для lobby host UI.
 * См. backend/api/routers/stories.py.
 */
import httpClient from './httpClient';

export interface PublicStoryItem {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string | null;
}

export interface PublicStoriesListResponse {
  stories: PublicStoryItem[];
}

export const storiesApi = {
  list: () => httpClient.get<PublicStoriesListResponse>('/stories'),
};
