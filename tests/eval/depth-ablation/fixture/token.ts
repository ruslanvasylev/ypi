export interface TokenClaims { exp: number; sub: string }

export function isFresh(claims: TokenClaims, skewSeconds = 0): boolean {
  return claims.exp > Date.now() + skewSeconds;
}
