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
      staging_url: 'https://staff-staging.lunafrontdesk.com',
      staging_url_href: true,
      production_url: 'https://wolfhouse.lunafrontdesk.com',
      production_url_href: true,
      status: 'Coming soon',
    },
    {
      id: 'sunset-somo',
      name: 'Sunset Somo',
      client_slug: 'sunset',
      type: 'Surf school',
      staging_url: 'https://sunset-staging.lunafrontdesk.com',
      staging_url_href: true,
      production_url: 'Coming soon / not linked',
      production_url_href: false,
      status: 'Coming soon',
    },
    {
      id: 'sunset-sardinero',
      name: 'Sunset Sardinero',
      client_slug: 'sunset-sardinero',
      type: 'Surf school',
      staging_url: 'Coming soon',
      staging_url_href: false,
      production_url: 'Coming soon',
      production_url_href: false,
      status: 'Coming soon',
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
