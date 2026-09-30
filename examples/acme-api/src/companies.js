import { companies } from "./data.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_PER_PAGE = 25;
const MAX_PAGE = 40;

/** Query parameters `/companies/search` understands. Anything else is ignored. */
export const SEARCH_PARAMS = ["q", "industry", "country", "page", "per_page"];

function toPublic(company) {
  const { jobs, ...rest } = company;
  return { ...rest, open_jobs: jobs.length };
}

/**
 * GET /companies/search
 * Filters: q (name contains), industry, country (ISO 3166-1 alpha-2).
 */
export function searchCompanies(params = {}) {
  const page = Number(params.page ?? 1);
  const perPage = Math.min(Number(params.per_page ?? MAX_PER_PAGE), MAX_PER_PAGE);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) throw new ApiError(400, "invalid page");
  if (params.country && !/^[A-Z]{2}$/.test(params.country)) throw new ApiError(400, "invalid request");

  let results = companies;
  if (params.q) {
    const q = String(params.q).toLowerCase();
    results = results.filter((c) => c.name.toLowerCase().includes(q));
  }
  if (params.industry) results = results.filter((c) => c.industry === params.industry);
  if (params.country) results = results.filter((c) => c.country === params.country);

  const start = (page - 1) * perPage;
  return {
    data: results.slice(start, start + perPage).map(toPublic),
    page,
    per_page: perPage,
    total: results.length,
  };
}

/** GET /companies/{id} */
export function getCompany(id) {
  const company = companies.find((c) => c.id === id);
  if (!company) throw new ApiError(404, "company not found");
  return toPublic(company);
}

/** GET /companies/{id}/jobs */
export function listJobs(id) {
  const company = companies.find((c) => c.id === id);
  if (!company) throw new ApiError(404, "company not found");
  return { data: company.jobs };
}
