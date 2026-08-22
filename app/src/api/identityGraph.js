import { http } from '../lib/http'

// Member identity graph. Admin Center only (PAMAuth + RequireAdmin).
//
// This is NOT the privilege-path analysis (escalation routes to crown jewels).
// It answers a different question: how is ONE account assembled? User type,
// extra roles, the policies those carry, and the concrete resources and
// credentials those policies actually match.
//
// The response carries both shapes of the same facts:
//   * a nested tree (user_type / additional_roles / direct_policies), which is
//     what a panel renders, and
//   * a flat nodes/edges pair, which is what a canvas renders.
// The graph page uses the tree, because the tree already encodes the
// parent-child structure the expansion model needs, and the flat list would
// have to be re-nested to get it back.

/** GET /api/v1/pam/admin/identity/users/{id}/graph */
export async function getMemberGraph(userId, signal) {
  const { data } = await http.get(`/api/v1/pam/admin/identity/users/${userId}/graph`, { signal })
  return data.data?.graph ?? data.data
}
