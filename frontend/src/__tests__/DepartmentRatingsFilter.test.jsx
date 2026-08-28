import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Ratings from '../pages/Ratings';
import DepartmentRatingsSheet from '../components/department/DepartmentRatingsSheet';
import api from '../lib/axios';
import useAuthStore from '../store/auth';

vi.mock('../lib/axios');
vi.mock('../store/auth');

const mockDepartments = [
  { id: 'dept-1', name: 'Engineering' },
  { id: 'dept-2', name: 'Marketing' },
];

const mockTeamMembers = [
  {
    id: 'user-1',
    full_name: 'Alice Cooper',
    email: 'alice@example.com',
    intern_code: 'INT-001',
    role: 'INTERN',
    department_id: 'dept-1',
    department_name: 'Engineering',
  },
  {
    id: 'user-2',
    full_name: 'Bob Marley',
    email: 'bob@example.com',
    intern_code: 'INT-002',
    role: 'INTERN',
    department_id: 'dept-2',
    department_name: 'Marketing',
  },
];

const mockSheetData = {
  available_months: ['2026-08'],
  members: [
    {
      id: 'user-1',
      full_name: 'Alice Cooper',
      email: 'alice@example.com',
      intern_code: 'INT-001',
      role: 'INTERN',
      internship_status: 'ACTIVE',
      suspended: false,
      weekly_ratings: [
        {
          score: 8.4,
          remarks: 'Great work',
          period_start: '2026-08-03',
          period_end: '2026-08-08',
        },
        {
          score: 9,
          remarks: 'Excellent follow-through',
          period_start: '2026-08-10',
          period_end: '2026-08-15',
        },
      ],
    },
    {
      id: 'user-2',
      full_name: 'Bob Marley',
      email: 'bob@example.com',
      intern_code: 'INT-002',
      role: 'INTERN',
      internship_status: 'ACTIVE',
      suspended: false,
      weekly_ratings: [
        {
          score: 3.2,
          remarks: 'Needs improvement',
          period_start: '2026-08-03',
          period_end: '2026-08-08',
        },
      ],
    },
    {
      id: 'user-3',
      full_name: 'Charlie Chaplin',
      email: 'charlie@example.com',
      intern_code: 'INT-003',
      role: 'INTERN',
      internship_status: 'COMPLETED',
      suspended: false,
      weekly_ratings: [
        {
          score: 5,
          remarks: 'Good progress',
          period_start: '2026-08-10',
          period_end: '2026-08-15',
        },
      ],
    },
  ],
};

const renderSheet = (overrides = {}) =>
  render(
    <DepartmentRatingsSheet
      departmentName="Engineering"
      data={mockSheetData}
      selectedMonth="2026-08"
      onMonthChange={vi.fn()}
      isLoading={false}
      error={null}
      onRetry={vi.fn()}
      {...overrides}
    />
  );

describe('Department Ratings Sheet & Filtering', () => {
  let queryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    useAuthStore.mockReturnValue({
      id: 'admin-1',
      role: 'ADMIN',
      email: 'admin@example.com',
    });

    api.get.mockImplementation((url) => {
      if (url === '/departments') {
        return Promise.resolve({ data: mockDepartments });
      }
      if (url === '/team/members') {
        return Promise.resolve({ data: mockTeamMembers });
      }
      if (url.includes('/ratings/department/')) {
        return Promise.resolve({ data: mockSheetData });
      }
      if (url.startsWith('/ratings/')) {
        return Promise.resolve({ data: [] });
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
  });

  it('renders the current weekly ratings grid', () => {
    renderSheet();

    expect(screen.getByText('Alice Cooper')).toBeInTheDocument();
    expect(screen.getByText('Bob Marley')).toBeInTheDocument();
    expect(screen.getByText('Charlie Chaplin')).toBeInTheDocument();
    expect(screen.getByText('8.4/10')).toBeInTheDocument();
    expect(screen.getByText('3.2/10')).toBeInTheDocument();
    expect(screen.getByText('5/10')).toBeInTheDocument();
  });

  it('renders weekly periods and their reasons', () => {
    renderSheet();

    expect(screen.getByText('Week 1')).toBeInTheDocument();
    expect(screen.getByText('Week 2')).toBeInTheDocument();
    expect(screen.getByText('Great work')).toBeInTheDocument();
    expect(screen.getByText('Excellent follow-through')).toBeInTheDocument();
    expect(screen.getByText('Needs improvement')).toBeInTheDocument();
    expect(screen.getByText('Good progress')).toBeInTheDocument();
  });

  it('uses the current month-selection contract', () => {
    const onMonthChange = vi.fn();

    renderSheet({
      selectedMonth: '2026-07',
      onMonthChange,
    });

    expect(onMonthChange).toHaveBeenCalledWith('2026-08');
  });

  it('filters members by search query', () => {
    renderSheet();

    fireEvent.change(screen.getByPlaceholderText(/Search members/i), {
      target: { value: 'Alice' },
    });

    expect(screen.getByText('Alice Cooper')).toBeInTheDocument();
    expect(screen.queryByText('Bob Marley')).not.toBeInTheDocument();
    expect(screen.queryByText('Charlie Chaplin')).not.toBeInTheDocument();
    expect(screen.getByText('Total Interns: 1')).toBeInTheDocument();
  });

  it('shows View All after an Admin selects a department', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/ratings']}>
          <Routes>
            <Route path="/ratings" element={<Ratings />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('View Ratings History')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /All departments/i })
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /All departments/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Engineering' }));

    const viewAllButton = await screen.findByRole('button', {
      name: /View All/i,
    });
    fireEvent.click(viewAllButton);

    expect(
      await screen.findByText('Department ratings sheet')
    ).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(
      '/ratings/department/dept-1/sheet',
      expect.objectContaining({
        params: expect.objectContaining({
          from: expect.stringMatching(/^\d{4}-\d{2}-01$/),
          to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      })
    );
  });
});
