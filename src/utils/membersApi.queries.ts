// FLC member GraphQL queries — Neo4j-GraphQL flavor.
//
// Schema notes (discovered via introspection 2026-05-10):
//   - The GraphQL endpoint is open (no auth required for read queries).
//   - Member.id is a uuid-formatted ID.
//   - Filtering follows Neo4j-GraphQL conventions: <field>_EQ, <field>_IN,
//     <relation>_SOME (matches if any related node satisfies), _ALL, _NONE.
//   - The 7 leadership levels each expose a leads<Level>_SOME and
//     isAdminFor<Level>_SOME filter (Bacenta has no isAdminFor — only leads).
//
// The app's universe is leaders + admins only. Every query below adds an
// OR-of-leadership-relationship filter to exclude regular members.

import { gql } from 'graphql-request'

// ─── Fragments ──────────────────────────────────────────────────────────────
// Fields shared across every Member fetch. Keep this minimal — we only sync
// what we need into member_profiles. Pull more later if a screen needs it.
export const MEMBER_FIELDS = gql`
  fragment MemberFields on Member {
    id
    firstName
    middleName
    lastName
    fullName
    email
    phoneNumber
    whatsappNumber
    pictureUrl
    bacenta { id name }
    leadsBacenta { id name governorship { id name council { id name stream { id name campus { id name oversight { id name denomination { id name } } } } } } }
    leadsGovernorship { id name council { id name stream { id name campus { id name oversight { id name denomination { id name } } } } } }
    leadsCouncil { id name stream { id name campus { id name oversight { id name denomination { id name } } } } }
    leadsStream { id name campus { id name oversight { id name denomination { id name } } } }
    leadsCampus { id name oversight { id name denomination { id name } } }
    leadsOversight { id name denomination { id name } }
    leadsDenomination { id name }
    isAdminForGovernorship { id name council { id name stream { id name campus { id name oversight { id name denomination { id name } } } } } }
    isAdminForCouncil { id name stream { id name campus { id name oversight { id name denomination { id name } } } } }
    isAdminForStream { id name campus { id name oversight { id name denomination { id name } } } }
    isAdminForCampus { id name oversight { id name denomination { id name } } }
    isAdminForOversight { id name denomination { id name } }
    isAdminForDenomination { id name }
  }
`

// ─── Filter snippet — "is a leader OR admin somewhere" ──────────────────────
// Used as the OR clause of every member-listing query. Keeps regular non-
// leadership members out of the app's universe. Centralised here so the
// definition of "leader" is in one place.
const LEADER_OR_ADMIN_OR_FILTER = `OR: [
    { leadsBacenta_SOME: {} },
    { leadsGovernorship_SOME: {} },
    { leadsCouncil_SOME: {} },
    { leadsStream_SOME: {} },
    { leadsCampus_SOME: {} },
    { leadsOversight_SOME: {} },
    { leadsDenomination_SOME: {} },
    { isAdminForGovernorship_SOME: {} },
    { isAdminForCouncil_SOME: {} },
    { isAdminForStream_SOME: {} },
    { isAdminForCampus_SOME: {} },
    { isAdminForOversight_SOME: {} },
    { isAdminForDenomination_SOME: {} }
  ]`

// ─── GET_MEMBER_BY_ID ───────────────────────────────────────────────────────
// Fetch a single member by graph id.
// Note: we removed the LEADER_OR_ADMIN_OR_FILTER from this query because the
// Neo4j _SOME:{} filter has odd semantics (matches any member regardless of
// whether the relationship list is populated), making it a no-op here. The
// `isLeaderOrAdmin()` helper performs the real check on the returned node.
export const GET_MEMBER_BY_ID = gql`
  ${MEMBER_FIELDS}
  query GetMemberById($id: ID!) {
    members(where: { id_EQ: $id }, limit: 1) {
      ...MemberFields
    }
  }
`

// ─── GET_MEMBER_BY_EMAIL ────────────────────────────────────────────────────
// Fallback lookup when the JWT's userId doesn't match the FLC member graph id
// (the auth API and the member graph may use different ID systems).
export const GET_MEMBER_BY_EMAIL = gql`
  ${MEMBER_FIELDS}
  query GetMemberByEmail($email: String!) {
    members(where: { email_EQ: $email }, limit: 1) {
      ...MemberFields
    }
  }
`

// ─── GET_MEMBERS_IN_SCOPE ───────────────────────────────────────────────────
// Returns every leader/admin whose leads* or isAdminFor* relationship targets
// a node within the given scope.
//
// Scope hierarchy (lowest → highest):
//   bacenta → governorship → council → stream → campus → oversight → denomination
//
// "In scope" means: the leader's relationship target either IS the scope
// node, OR sits at a child level under it. The Neo4j-GraphQL `_SOME` filter
// accepts a nested where, so we can express "leads a Bacenta whose
// governorship.id_EQ X" by filtering Bacenta.governorship_SOME.id_EQ X.
//
// We build this query dynamically in membersApi.js to keep the generated
// where clause shallow per scope. Each scope-targeting query is its own
// constant below.

export const GET_MEMBERS_FOR_BACENTA = gql`
  ${MEMBER_FIELDS}
  query GetMembersForBacenta($churchId: ID!) {
    members(
      where: {
        OR: [
          { leadsBacenta_SOME: { id_EQ: $churchId } }
        ]
      }
    ) {
      ...MemberFields
    }
  }
`

export const GET_MEMBERS_FOR_GOVERNORSHIP = gql`
  ${MEMBER_FIELDS}
  query GetMembersForGovernorship($churchId: ID!) {
    members(
      where: {
        OR: [
          { leadsGovernorship_SOME: { id_EQ: $churchId } },
          { isAdminForGovernorship_SOME: { id_EQ: $churchId } },
          { leadsBacenta_SOME: { governorship: { id_EQ: $churchId } } }
        ]
      }
    ) {
      ...MemberFields
    }
  }
`

export const GET_MEMBERS_FOR_COUNCIL = gql`
  ${MEMBER_FIELDS}
  query GetMembersForCouncil($churchId: ID!) {
    members(
      where: {
        OR: [
          { leadsCouncil_SOME: { id_EQ: $churchId } },
          { isAdminForCouncil_SOME: { id_EQ: $churchId } },
          { leadsGovernorship_SOME: { council: { id_EQ: $churchId } } },
          { isAdminForGovernorship_SOME: { council: { id_EQ: $churchId } } },
          { leadsBacenta_SOME: { governorship: { council: { id_EQ: $churchId } } } }
        ]
      }
    ) {
      ...MemberFields
    }
  }
`

export const GET_MEMBERS_FOR_STREAM = gql`
  ${MEMBER_FIELDS}
  query GetMembersForStream($churchId: ID!) {
    members(
      where: {
        OR: [
          { leadsStream_SOME: { id_EQ: $churchId } },
          { isAdminForStream_SOME: { id_EQ: $churchId } },
          { leadsCouncil_SOME: { stream: { id_EQ: $churchId } } },
          { isAdminForCouncil_SOME: { stream: { id_EQ: $churchId } } },
          { leadsGovernorship_SOME: { council: { stream: { id_EQ: $churchId } } } },
          { isAdminForGovernorship_SOME: { council: { stream: { id_EQ: $churchId } } } },
          { leadsBacenta_SOME: { governorship: { council: { stream: { id_EQ: $churchId } } } } }
        ]
      }
    ) {
      ...MemberFields
    }
  }
`

export const GET_MEMBERS_FOR_CAMPUS = gql`
  ${MEMBER_FIELDS}
  query GetMembersForCampus($churchId: ID!) {
    members(
      where: {
        OR: [
          { leadsCampus_SOME: { id_EQ: $churchId } },
          { isAdminForCampus_SOME: { id_EQ: $churchId } },
          { leadsStream_SOME: { campus: { id_EQ: $churchId } } },
          { isAdminForStream_SOME: { campus: { id_EQ: $churchId } } },
          { leadsCouncil_SOME: { stream: { campus: { id_EQ: $churchId } } } },
          { isAdminForCouncil_SOME: { stream: { campus: { id_EQ: $churchId } } } },
          { leadsGovernorship_SOME: { council: { stream: { campus: { id_EQ: $churchId } } } } },
          { isAdminForGovernorship_SOME: { council: { stream: { campus: { id_EQ: $churchId } } } } },
          { leadsBacenta_SOME: { governorship: { council: { stream: { campus: { id_EQ: $churchId } } } } } }
        ]
      }
    ) {
      ...MemberFields
    }
  }
`

export const GET_MEMBERS_FOR_OVERSIGHT = gql`
  ${MEMBER_FIELDS}
  query GetMembersForOversight($churchId: ID!) {
    members(
      where: {
        OR: [
          { leadsOversight_SOME: { id_EQ: $churchId } },
          { isAdminForOversight_SOME: { id_EQ: $churchId } },
          { leadsCampus_SOME: { oversight: { id_EQ: $churchId } } },
          { isAdminForCampus_SOME: { oversight: { id_EQ: $churchId } } },
          { leadsStream_SOME: { campus: { oversight: { id_EQ: $churchId } } } },
          { isAdminForStream_SOME: { campus: { oversight: { id_EQ: $churchId } } } },
          { leadsCouncil_SOME: { stream: { campus: { oversight: { id_EQ: $churchId } } } } },
          { isAdminForCouncil_SOME: { stream: { campus: { oversight: { id_EQ: $churchId } } } } },
          { leadsGovernorship_SOME: { council: { stream: { campus: { oversight: { id_EQ: $churchId } } } } } },
          { isAdminForGovernorship_SOME: { council: { stream: { campus: { oversight: { id_EQ: $churchId } } } } } },
          { leadsBacenta_SOME: { governorship: { council: { stream: { campus: { oversight: { id_EQ: $churchId } } } } } } }
        ]
      }
    ) {
      ...MemberFields
    }
  }
`

export const GET_MEMBERS_FOR_DENOMINATION = gql`
  ${MEMBER_FIELDS}
  query GetMembersForDenomination($churchId: ID!) {
    members(
      where: {
        OR: [
          { leadsDenomination_SOME: { id_EQ: $churchId } },
          { isAdminForDenomination_SOME: { id_EQ: $churchId } },
          { leadsOversight_SOME: { denomination: { id_EQ: $churchId } } },
          { isAdminForOversight_SOME: { denomination: { id_EQ: $churchId } } },
          { leadsCampus_SOME: { oversight: { denomination: { id_EQ: $churchId } } } },
          { isAdminForCampus_SOME: { oversight: { denomination: { id_EQ: $churchId } } } },
          { leadsStream_SOME: { campus: { oversight: { denomination: { id_EQ: $churchId } } } } },
          { isAdminForStream_SOME: { campus: { oversight: { denomination: { id_EQ: $churchId } } } } },
          { leadsCouncil_SOME: { stream: { campus: { oversight: { denomination: { id_EQ: $churchId } } } } } },
          { isAdminForCouncil_SOME: { stream: { campus: { oversight: { denomination: { id_EQ: $churchId } } } } } },
          { leadsGovernorship_SOME: { council: { stream: { campus: { oversight: { denomination: { id_EQ: $churchId } } } } } } },
          { isAdminForGovernorship_SOME: { council: { stream: { campus: { oversight: { denomination: { id_EQ: $churchId } } } } } } },
          { leadsBacenta_SOME: { governorship: { council: { stream: { campus: { oversight: { denomination: { id_EQ: $churchId } } } } } } } }
        ]
      }
    ) {
      ...MemberFields
    }
  }
`

// ─── Pick the right query for a scope level ─────────────────────────────────
export const SCOPE_QUERIES = {
  bacenta:      GET_MEMBERS_FOR_BACENTA,
  governorship: GET_MEMBERS_FOR_GOVERNORSHIP,
  council:      GET_MEMBERS_FOR_COUNCIL,
  stream:       GET_MEMBERS_FOR_STREAM,
  campus:       GET_MEMBERS_FOR_CAMPUS,
  oversight:    GET_MEMBERS_FOR_OVERSIGHT,
  denomination: GET_MEMBERS_FOR_DENOMINATION,
}

// ─── Hierarchy walks ────────────────────────────────────────────────────────
// One query per starting level; each walks up to denomination so we can
// build the full ancestor chain for any church node.

export const GET_BACENTA_ANCESTORS = gql`
  query GetBacentaAncestors($id: ID!) {
    bacentas(where: { id_EQ: $id }, limit: 1) {
      id name
      governorship { id name
        council { id name
          stream { id name
            campus { id name
              oversight { id name
                denomination { id name }
              }
            }
          }
        }
      }
    }
  }
`

export const GET_GOVERNORSHIP_ANCESTORS = gql`
  query GetGovernorshipAncestors($id: ID!) {
    governorships(where: { id_EQ: $id }, limit: 1) {
      id name
      council { id name
        stream { id name
          campus { id name
            oversight { id name
              denomination { id name }
            }
          }
        }
      }
    }
  }
`

export const GET_COUNCIL_ANCESTORS = gql`
  query GetCouncilAncestors($id: ID!) {
    councils(where: { id_EQ: $id }, limit: 1) {
      id name
      stream { id name
        campus { id name
          oversight { id name
            denomination { id name }
          }
        }
      }
    }
  }
`

export const GET_STREAM_ANCESTORS = gql`
  query GetStreamAncestors($id: ID!) {
    streams(where: { id_EQ: $id }, limit: 1) {
      id name
      campus { id name
        oversight { id name
          denomination { id name }
        }
      }
    }
  }
`

export const GET_CAMPUS_ANCESTORS = gql`
  query GetCampusAncestors($id: ID!) {
    campuses(where: { id_EQ: $id }, limit: 1) {
      id name
      oversight { id name
        denomination { id name }
      }
    }
  }
`

export const GET_OVERSIGHT_ANCESTORS = gql`
  query GetOversightAncestors($id: ID!) {
    oversights(where: { id_EQ: $id }, limit: 1) {
      id name
      denomination { id name }
    }
  }
`

export const ANCESTOR_QUERIES = {
  bacenta:      GET_BACENTA_ANCESTORS,
  governorship: GET_GOVERNORSHIP_ANCESTORS,
  council:      GET_COUNCIL_ANCESTORS,
  stream:       GET_STREAM_ANCESTORS,
  campus:       GET_CAMPUS_ANCESTORS,
  oversight:    GET_OVERSIGHT_ANCESTORS,
  // denomination has no ancestors
}

// ─── Child-scope counts ─────────────────────────────────────────────────────
// For each level, count the direct children. Used for the "Councils: N"
// style stat card on the dashboard.
//
// Each query returns { <pluralChild>Connection: { totalCount } } — Neo4j-
// GraphQL exposes counts via the *Connection siblings.

export const COUNT_GOVERNORSHIPS_IN_COUNCIL = gql`
  query CountGovernorshipsInCouncil($id: ID!) {
    governorshipsConnection(where: { council: { id_EQ: $id } }) { totalCount }
  }
`

export const COUNT_COUNCILS_IN_STREAM = gql`
  query CountCouncilsInStream($id: ID!) {
    councilsConnection(where: { stream: { id_EQ: $id } }) { totalCount }
  }
`

export const COUNT_STREAMS_IN_CAMPUS = gql`
  query CountStreamsInCampus($id: ID!) {
    streamsConnection(where: { campus: { id_EQ: $id } }) { totalCount }
  }
`

export const COUNT_CAMPUSES_IN_OVERSIGHT = gql`
  query CountCampusesInOversight($id: ID!) {
    campusesConnection(where: { oversight: { id_EQ: $id } }) { totalCount }
  }
`

export const COUNT_OVERSIGHTS_IN_DENOMINATION = gql`
  query CountOversightsInDenomination($id: ID!) {
    oversightsConnection(where: { denomination: { id_EQ: $id } }) { totalCount }
  }
`

export const COUNT_BACENTAS_IN_GOVERNORSHIP = gql`
  query CountBacentasInGovernorship($id: ID!) {
    bacentasConnection(where: { governorship: { id_EQ: $id } }) { totalCount }
  }
`

// Map parent-level → child count query.
export const CHILD_COUNT_QUERIES = {
  governorship: COUNT_BACENTAS_IN_GOVERNORSHIP,
  council:      COUNT_GOVERNORSHIPS_IN_COUNCIL,
  stream:       COUNT_COUNCILS_IN_STREAM,
  campus:       COUNT_STREAMS_IN_CAMPUS,
  oversight:    COUNT_CAMPUSES_IN_OVERSIGHT,
  denomination: COUNT_OVERSIGHTS_IN_DENOMINATION,
}

// ─── List child church nodes (id + name) for a given parent ─────────────────
// Used by ScopeBreakdown to anchor groups so empty child scopes still appear.

export const LIST_BACENTAS_IN_GOVERNORSHIP = gql`
  query ListBacentasInGovernorship($id: ID!) {
    bacentas(where: { governorship: { id_EQ: $id } }) { id name }
  }
`

export const LIST_GOVERNORSHIPS_IN_COUNCIL = gql`
  query ListGovernorshipsInCouncil($id: ID!) {
    governorships(where: { council: { id_EQ: $id } }) { id name }
  }
`

export const LIST_COUNCILS_IN_STREAM = gql`
  query ListCouncilsInStream($id: ID!) {
    councils(where: { stream: { id_EQ: $id } }) { id name }
  }
`

export const LIST_STREAMS_IN_CAMPUS = gql`
  query ListStreamsInCampus($id: ID!) {
    streams(where: { campus: { id_EQ: $id } }) { id name }
  }
`

export const LIST_CAMPUSES_IN_OVERSIGHT = gql`
  query ListCampusesInOversight($id: ID!) {
    campuses(where: { oversight: { id_EQ: $id } }) { id name }
  }
`

export const LIST_OVERSIGHTS_IN_DENOMINATION = gql`
  query ListOversightsInDenomination($id: ID!) {
    oversights(where: { denomination: { id_EQ: $id } }) { id name }
  }
`

export const CHILD_LIST_QUERIES = {
  governorship: LIST_BACENTAS_IN_GOVERNORSHIP,
  council:      LIST_GOVERNORSHIPS_IN_COUNCIL,
  stream:       LIST_COUNCILS_IN_STREAM,
  campus:       LIST_STREAMS_IN_CAMPUS,
  oversight:    LIST_CAMPUSES_IN_OVERSIGHT,
  denomination: LIST_OVERSIGHTS_IN_DENOMINATION,
}
