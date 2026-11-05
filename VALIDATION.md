# Validation record

Validated locally on Windows with Node.js 24.13.0 and the bundled PostgreSQL 18.6 binaries.

- TypeScript strict checking and Vite production build pass.
- All 10 database/API integration tests pass, including both actor orders and 15 repeated atomic-claim runs.
- Browser flows reproduce double booking and verify both fixes, including the manual lock checkpoint.
- Mobile viewport tested at 390px; horizontal page overflow corrected and checked.
- Generated JSON report was parsed and checked. The exported Node regression test was executed successfully against the running API.
- No browser JavaScript errors were observed during the passing browser flow.

The execution environment canceled browser filesystem downloads. Export contents were therefore captured from the actual generated blobs using `CAPTURE_EXPORTS=1`, then saved and executed by the test runner. Native browser saving remains unverified here; the default browser test exercises it without interception.

CI configuration and the Docker alternative are provided but have not been executed on GitHub or Docker in this environment. No performance or scalability benchmark has been performed.
