# Contributing

We welcome human-led contributions that solve a real problem and are easy to
review.

## Before opening an issue or pull request

- Search existing issues first.
- For a feature or non-trivial change, open an issue and wait for approval.
- Keep the change focused and never include secrets.

## Bug reports

Use the **Bug report** form. Please include the version, environment, exact
steps, expected and actual behavior, and a minimal reproduction or sanitized
error output. Only report problems you personally reproduced or verified.

## Pull requests

1. Link the issue or approved direction.
2. Keep the diff focused and add tests for behavior changes.
3. Update docs when public behavior changes.
4. Run the package check and include the result:

   ```sh
   nub run check
   nub pack --dry-run
   ```

5. Be ready to explain the change in your own words.

## Releases

Keep the package version, changelog entry, Git tag, GitHub Release, and npm
package on the same patch version.

1. Update `package.json` and the matching top entry in `CHANGELOG.md`.
2. Run `nub run check` and `nub pack --dry-run`.
3. Commit the release metadata, create the matching annotated tag, and push both:

   ```sh
   git commit -m "chore(release): prepare vX.Y.Z"
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main vX.Y.Z
   ```

4. Create and publish the GitHub Release for `vX.Y.Z`, using the matching
   `CHANGELOG.md` section as its notes.
5. Publish `aisubs@X.Y.Z` to npm and verify the registry version.

## AI-assisted work

AI tools are allowed. A human must own, review, test, explain, and submit the
work. Bots, autonomous agents, and automated pull requests or issue reports
are not allowed. If AI materially helped create a contribution, disclose it
and review the result yourself. Maintainers may close work that cannot be
independently verified.

Use your own GitHub account and submit only work you have the right to
contribute.
