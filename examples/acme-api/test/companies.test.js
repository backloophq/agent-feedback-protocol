import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, getCompany, listJobs, searchCompanies } from "../src/companies.js";

test("search returns every company by default, paginated", () => {
  const result = searchCompanies();
  assert.equal(result.total, 20);
  assert.equal(result.data.length, 20);
  assert.equal(result.per_page, 25);
});

test("search filters by name, industry and country", () => {
  assert.deepEqual(
    searchCompanies({ q: "lumen" }).data.map((c) => c.name),
    ["Lumen Pay"],
  );
  assert.ok(searchCompanies({ industry: "fintech" }).data.every((c) => c.industry === "fintech"));
  assert.ok(searchCompanies({ country: "GB" }).data.every((c) => c.country === "GB"));
});

test("search combines filters", () => {
  const result = searchCompanies({ industry: "saas", country: "US" });
  assert.deepEqual(result.data.map((c) => c.name).sort(), ["Helix Security", "Tessellate AI"]);
});

test("search rejects out-of-range pages", () => {
  assert.throws(() => searchCompanies({ page: 41 }), ApiError);
});

test("search rejects country names", () => {
  assert.throws(() => searchCompanies({ country: "Germany" }), ApiError);
});

test("companies expose the number of open jobs, jobs are listed separately", () => {
  const company = getCompany("cmp_001");
  assert.equal(company.open_jobs, 2);
  assert.equal(company.jobs, undefined);
  assert.deepEqual(
    listJobs("cmp_001").data.map((j) => j.role),
    ["gtm_engineer", "account_executive"],
  );
});

test("unknown companies are 404s", () => {
  assert.throws(() => getCompany("cmp_999"), (e) => e instanceof ApiError && e.status === 404);
});
