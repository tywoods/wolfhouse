/** @jsxImportSource preact */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import LeadForm from './LeadForm';
import { LEAD_GENERIC_ERROR, LEAD_API_PATH } from './leadApi';
import { LEAD_MAX_LENGTH } from './leadSchema';

function fillValid(container: Element) {
  fireEvent.input(container.querySelector('#name')!, { target: { value: 'Maria Garcia' } });
  fireEvent.input(container.querySelector('#businessName')!, {
    target: { value: 'Surf Hostel' },
  });
  fireEvent.input(container.querySelector('#contact')!, {
    target: { value: 'maria@example.com' },
  });
  fireEvent.change(container.querySelector('#businessType')!, {
    target: { value: 'hostel' },
  });
}

describe('LeadForm (disabled API)', () => {
  afterEach(() => cleanup());

  it('states before submit that data will not be sent or saved', () => {
    const { getByTestId } = render(<LeadForm apiEnabled={false} />);
    const truth = getByTestId('lead-disabled-truth');
    expect(truth.textContent).toMatch(/will not send or save/i);
  });

  it('retains values, offers mailto, and makes no network call on submit', async () => {
    const fetchImpl = vi.fn();
    const { container, getByTestId, queryByText } = render(
      <LeadForm apiEnabled={false} fetchImpl={fetchImpl} />,
    );
    fillValid(container);
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(getByTestId('lead-local-outcome')).toBeTruthy();
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect((container.querySelector('#name') as HTMLInputElement).value).toBe('Maria Garcia');
    expect((container.querySelector('#businessName') as HTMLInputElement).value).toBe(
      'Surf Hostel',
    );
    expect((container.querySelector('#contact') as HTMLInputElement).value).toBe(
      'maria@example.com',
    );

    const mailto = getByTestId('lead-mailto') as HTMLAnchorElement;
    expect(mailto.getAttribute('href')).toMatch(/^mailto:hello@lunafrontdesk\.com\?/);
    expect(mailto.getAttribute('href')).toContain(encodeURIComponent('Maria Garcia'));

    // No success / captured language.
    expect(queryByText(/you're on the list/i)).toBeNull();
    expect(queryByText(/we've noted/i)).toBeNull();
    expect(queryByText(/captured/i)).toBeNull();
    expect(getByTestId('lead-local-outcome').textContent).toMatch(/Nothing was sent or saved/i);
  });

  it('links to the privacy notice beside submit', () => {
    const { getByTestId } = render(<LeadForm apiEnabled={false} />);
    const link = getByTestId('lead-privacy-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/privacy/');
  });

  it('sets maxlength on text fields', () => {
    const { container } = render(<LeadForm apiEnabled={false} />);
    expect((container.querySelector('#name') as HTMLInputElement).maxLength).toBe(
      LEAD_MAX_LENGTH.name,
    );
    expect((container.querySelector('#businessName') as HTMLInputElement).maxLength).toBe(
      LEAD_MAX_LENGTH.businessName,
    );
    expect((container.querySelector('#contact') as HTMLInputElement).maxLength).toBe(
      LEAD_MAX_LENGTH.contact,
    );
    expect((container.querySelector('#freeText') as HTMLTextAreaElement).maxLength).toBe(
      LEAD_MAX_LENGTH.freeText,
    );
  });
});

describe('LeadForm (enabled API failures)', () => {
  afterEach(() => cleanup());

  it('shows a generic error and never displays the raw response body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('RAW_SERVER_STACKTRACE_SECRET', { status: 502 }),
    );
    const { container, getByTestId, queryByText } = render(
      <LeadForm apiEnabled={true} fetchImpl={fetchImpl} />,
    );
    fillValid(container);
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(getByTestId('lead-generic-error')).toBeTruthy();
    });

    expect(fetchImpl).toHaveBeenCalled();
    const firstCall = fetchImpl.mock.calls[0] as unknown as [string, RequestInit?];
    expect(firstCall[0]).toBe(LEAD_API_PATH);
    expect(getByTestId('lead-generic-error').textContent).toBe(LEAD_GENERIC_ERROR);
    expect(queryByText(/RAW_SERVER_STACKTRACE_SECRET/)).toBeNull();
  });
});
