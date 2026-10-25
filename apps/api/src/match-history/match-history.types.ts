/** One roster player as stored in `match_history_v1.players` (jsonb). */
export interface MatchHistoryPlayer {
  steamId?: string;
  name?: string;
  heroId?: number;
  heroName?: string;
  team?: number;
  lane?: number;
  level?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  souls?: number;
  heroDamage?: number;
  objectDamage?: number;
  healing?: number;
  isLocal?: boolean;
}
