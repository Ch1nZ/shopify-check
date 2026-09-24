# Contributing

Open an issue with the observed behavior, expected result and a minimal fictional fixture. Do not post private merchant reports, customer data, credentials or authenticated URLs. Use public product URLs only when appropriate to disclose them.

Run `npm ci`, then `npm run check` and `npm run dry-run`. For UI changes, verify desktop, mobile and keyboard use. Preserve distinctions between missing, conflicting and unavailable evidence. Avoid inferring AI recommendation outcomes from product-data checks.

Contributions are provided under Apache-2.0. By contributing, you confirm you have the right to submit the material. Use a GitHub-provided noreply commit address if you do not want your personal email in public history.

## Maintainer release procedure

1. Update the package version, document changes, and bump rule definition versions when their meanings change.
2. Run checks, build, privacy scan and deployment dry run. Inspect `npm pack --dry-run` and the staged diff. Never copy private application history or credentials into this repository.
3. Commit the reviewed source, tag `vX.Y.Z`, and publish a GitHub release.
4. Consumers update their Git dependency to the release commit, run their own integration checks and deploy. Do not edit duplicate copies of this library downstream.

The GitHub workflow runs tests and a build without production secrets. Releases do not automatically deploy anyone's hosted application.
