'use strict';

/**
 * Read-only business/location directory for Crowsnest.
 *
 * This deliberately contains only operator-facing routing metadata and known
 * portal URLs. It performs no tenant DB reads and exposes no create/update
 * operations.
 */

function getCrowsnestClients() {
  return [
    {
      id: 'wolfhouse-somo',
      name: 'Wolfhouse Somo',
      business: 'Wolfhouse',
      location: 'Somo, Spain',
      client_slug: 'wolfhouse-somo',
      type: 'Surf house',
      status: 'Live',
      status_note: 'Production and staging staff portals are available.',
      environments: [
        {
          label: 'Staff staging',
          kind: 'staff_portal',
          url: 'https://staff-staging.lunafrontdesk.com',
          state: 'linked',
        },
        {
          label: 'Staff production',
          kind: 'staff_portal',
          url: 'https://wolfhouse.lunafrontdesk.com',
          state: 'linked',
        },
      ],
    },
    {
      id: 'sunset-somo',
      name: 'Sunset Somo',
      business: 'Sunset Surf School',
      location: 'Somo, Spain',
      client_slug: 'sunset',
      type: 'Surf school',
      status: 'Staging',
      status_note: 'Staging staff portal is available; no production portal is listed.',
      environments: [
        {
          label: 'Staff staging',
          kind: 'staff_portal',
          url: 'https://sunset-staging.lunafrontdesk.com',
          state: 'linked',
        },
      ],
    },
    {
      id: 'sunset-sardinero',
      name: 'Sunset Sardinero',
      business: 'Sunset Surf School',
      location: 'Sardinero, Spain',
      client_slug: 'sunset-sardinero',
      type: 'Surf school',
      status: 'Planned',
      status_note: 'Directory placeholder only; no staff portal is available.',
      environments: [],
    },
  ];
}

module.exports = {
  getCrowsnestClients,
};
