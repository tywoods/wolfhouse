/** @jsxImportSource preact */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';
import LeadForm from './LeadForm';
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

describe('LeadForm (compile-time disabled)', () => {
  afterEach(() => cleanup());

  it('states before submit that data will not be sent or saved', () => {
    const { getByTestId } = render(<LeadForm />);
    const truth = getByTestId('lead-disabled-truth');
    expect(truth.textContent).toMatch(/will not send or save/i);
  });

  it('retains values, offers mailto, and makes no network call on submit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { container, getByTestId, queryByText } = render(<LeadForm />);
    fillValid(container);
    fireEvent.submit(container.querySelector('form')!);

    await waitFor(() => {
      expect(getByTestId('lead-local-outcome')).toBeTruthy();
    });

    expect(fetchSpy).not.toHaveBeenCalled();
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

    expect(queryByText(/you're on the list/i)).toBeNull();
    expect(queryByText(/we've noted/i)).toBeNull();
    expect(queryByText(/captured/i)).toBeNull();
    expect(getByTestId('lead-local-outcome').textContent).toMatch(/Nothing was sent or saved/i);
    fetchSpy.mockRestore();
  });

  it('links to the privacy notice beside submit', () => {
    const { getByTestId } = render(<LeadForm />);
    const link = getByTestId('lead-privacy-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/privacy/');
  });

  it('sets maxlength on text fields', () => {
    const { container } = render(<LeadForm />);
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

  it('rejects malformed contact on submit (no local outcome)', async () => {
    const { container, queryByTestId } = render(<LeadForm />);
    fireEvent.input(container.querySelector('#name')!, { target: { value: 'Maria' } });
    fireEvent.input(container.querySelector('#businessName')!, {
      target: { value: 'Hostel' },
    });
    fireEvent.input(container.querySelector('#contact')!, {
      target: { value: 'user@domain' },
    });
    fireEvent.change(container.querySelector('#businessType')!, {
      target: { value: 'hostel' },
    });
    fireEvent.submit(container.querySelector('form')!);
    expect(queryByTestId('lead-local-outcome')).toBeNull();
    expect(container.querySelector('#contact-error')?.textContent).toMatch(/email/i);
  });
});
