export const PACKAGE_NAME = 'adapters-1688';

export {
  ADAPTER_1688_MIN_ENGINE_VERSION,
  ADAPTER_1688_PLATFORM,
  ADAPTER_1688_VERSION,
  adapter1688Dsl,
} from './dsl.js';

export {
  API_1688_BASE_URL,
  API_1688_SEARCH_LIMIT,
  API_1688_SEARCH_PATH,
  API_1688_SKILL_VERSION,
  ApiCallError,
  buildSignedHeaders,
  extractAkKeys,
  searchOffers1688,
  type AkParts,
  type ApiFailureKind,
  type FetchLike,
  type SearchOfferItem,
  type SearchOffersParams,
} from './api-client.js';
