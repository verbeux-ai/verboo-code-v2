/**
 * Resolvable stand-in for a package's generated `./remote` contribution when this
 * checkout has no built `lib/`. A suite that exercises a Client assembly imports
 * the contribution transitively, and Vite resolves it while transforming the
 * entry — before `vi.mock` can answer it — so an absent build file would abort
 * the run instead of reaching the mock that replaces it.
 *
 * The stand-in is a real {@link TypertRemoteInfo} with no methods, so anything
 * that reads the contribution's package, descriptors, or methods gets the empty
 * answers of a contribution that declares none rather than a shape error.
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { z } from 'zod'

export default createTypertRemoteInfo({ package: '@deepseek-ai/dsh-remote-contribution', methods: {} }, z)
