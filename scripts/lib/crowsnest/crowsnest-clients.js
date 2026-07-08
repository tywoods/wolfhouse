'use strict';

/**
 * Static read-only client list for Crowsnest UI — no DB, no config file reads at runtime yet.
 */

function getCrowsnestClients() {
  return [
    {
      id: 'wolfhouse-somo',
      name: 'Wolfhouse Somo',
      client_slug: 'wolfhouse-somo',
      type: 'Surf house',
      status: 'Coming soon',
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
        {
          label: 'Luna WhatsApp',
          kind: 'whatsapp',
          state: 'coming_soon',
        },
        {
          label: 'Stripe',
          kind: 'payments',
          state: 'coming_soon',
        },
        {
          label: 'Database',
          kind: 'database',
          state: 'coming_soon',
        },
      ],
    },
    {
      id: 'sunset-somo',
      name: 'Sunset Somo',
      client_slug: 'sunset',
      type: 'Surf school',
      status: 'Coming soon',
      environments: [
        {
          label: 'Staff staging',
          kind: 'staff_portal',
          url: 'https://sunset-staging.lunafrontdesk.com',
          state: 'linked',
        },
        {
          label: 'Staff production',
          kind: 'staff_portal',
          state: 'coming_soon',
        },
        {
          label: 'Luna WhatsApp',
          kind: 'whatsapp',
          state: 'coming_soon',
        },
        {
          label: 'Stripe',
          kind: 'payments',
          state: 'coming_soon',
        },
        {
          label: 'Database',
          kind: 'database',
          state: 'coming_soon',
        },
      ],
    },
    {
      id: 'sunset-sardinero',
      name: 'Sunset Sardinero',
      client_slug: 'sunset-sardinero',
      type: 'Surf school',
      status: 'Coming soon',
      environments: [
        {
          label: 'Staff staging',
          kind: 'staff_portal',
          state: 'coming_soon',
        },
        {
          label: 'Staff production',
          kind: 'staff_portal',
          state: 'coming_soon',
        },
        {
          label: 'Luna WhatsApp',
          kind: 'whatsapp',
          state: 'coming_soon',
        },
        {
          label: 'Stripe',
          kind: 'payments',
          state: 'coming_soon',
        },
        {
          label: 'Database',
          kind: 'database',
          state: 'coming_soon',
        },
      ],
    },
  ];
}

function getCrowsnestTemplates() {
  return [
    { id: 'surf-house', label: 'Surf house template', status: 'Coming soon' },
    { id: 'surf-school', label: 'Surf school template', status: 'Coming soon' },
  ];
}

module.exports = {
  getCrowsnestClients,
  getCrowsnestTemplates,
};
