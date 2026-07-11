import path from "node:path";

export function isInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  return normalizedCandidate.startsWith(normalizedRoot);
}
