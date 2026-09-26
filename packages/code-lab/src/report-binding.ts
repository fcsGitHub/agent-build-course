/**
 * 校验报告绑定（T40；用例 10）。
 * 校验报告绑定 sourceDigest + baseManifestId + editPolicyDigest + toolchainDigest +
 * testSuiteDigest + bundleDigest；后续任意改动生成新草稿摘要，旧报告立即不适用。
 */
export interface BuildAttestation {
  sourceDigest: string;
  baseManifestId: string;
  editPolicyDigest: string;
  toolchainDigest: string;
  testSuiteDigest: string;
  bundleDigest: string;
}

export function matchesValidatedBuild(
  actual: BuildAttestation,
  attested: BuildAttestation,
): boolean {
  return (
    actual.sourceDigest === attested.sourceDigest &&
    actual.baseManifestId === attested.baseManifestId &&
    actual.editPolicyDigest === attested.editPolicyDigest &&
    actual.toolchainDigest === attested.toolchainDigest &&
    actual.testSuiteDigest === attested.testSuiteDigest &&
    actual.bundleDigest === attested.bundleDigest
  );
}
