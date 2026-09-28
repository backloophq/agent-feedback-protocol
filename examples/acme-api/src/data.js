// A small, fictional company dataset for the Acme Companies API demo.
// `employee_count` is a size band string, even though the docs call it an integer.

const COMPANIES = [
  ["Northwind Analytics", "northwind.io", "saas", "GB", "51-200", 2016, [["GTM Engineer", "gtm_engineer"], ["Account Executive", "account_executive"]]],
  ["Lumen Pay", "lumenpay.com", "fintech", "DE", "201-500", 2014, [["Sales Engineer", "sales_engineer"], ["GTM Engineer", "gtm_engineer"]]],
  ["Quarry Health", "quarryhealth.com", "healthcare", "US", "501-1000", 2011, [["Data Engineer", "data_engineer"]]],
  ["Fjord Logistics", "fjordlogistics.no", "logistics", "NO", "1001-5000", 2003, [["Operations Manager", "operations_manager"]]],
  ["Helix Security", "helixsec.io", "saas", "US", "201-500", 2015, [["SDR", "sdr"], ["RevOps Engineer", "revops_engineer"]]],
  ["Pantry Labs", "pantrylabs.co", "ecommerce", "FR", "11-50", 2020, [["Growth Marketer", "growth_marketer"]]],
  ["Orbital Freight", "orbitalfreight.com", "logistics", "GB", "201-500", 2012, [["Solutions Engineer", "sales_engineer"]]],
  ["Canopy CRM", "canopycrm.com", "saas", "NL", "51-200", 2018, [["GTM Engineer", "gtm_engineer"], ["SDR", "sdr"]]],
  ["Meridian Bank", "meridianbank.de", "fintech", "DE", "5001-10000", 1998, [["Backend Engineer", "backend_engineer"]]],
  ["Tessellate AI", "tessellate.ai", "saas", "US", "11-50", 2022, [["Founding GTM Engineer", "gtm_engineer"]]],
  ["Brightside Care", "brightsidecare.co.uk", "healthcare", "GB", "1001-5000", 2007, []],
  ["Kestrel Robotics", "kestrelrobotics.com", "manufacturing", "DE", "501-1000", 2010, [["Field Sales Engineer", "sales_engineer"]]],
  ["Ledgerly", "ledgerly.fr", "fintech", "FR", "51-200", 2019, [["RevOps Engineer", "revops_engineer"], ["Account Executive", "account_executive"]]],
  ["Signal Ridge", "signalridge.io", "saas", "IE", "201-500", 2013, [["SDR", "sdr"]]],
  ["Atlas Grocers", "atlasgrocers.com", "ecommerce", "US", "10001+", 1995, []],
  ["Pivotal Ops", "pivotalops.dev", "saas", "GB", "11-50", 2021, [["GTM Engineer", "gtm_engineer"]]],
  ["Clearwater Insure", "clearwaterinsure.com", "fintech", "US", "1001-5000", 2006, [["Data Analyst", "data_analyst"]]],
  ["Nimbus Health", "nimbushealth.de", "healthcare", "DE", "51-200", 2017, [["Sales Engineer", "sales_engineer"]]],
  ["Porter & Finch", "porterfinch.com", "logistics", "US", "501-1000", 2009, []],
  ["Stackwise", "stackwise.io", "saas", "FR", "51-200", 2018, [["GTM Engineer", "gtm_engineer"], ["Solutions Engineer", "sales_engineer"]]],
];

export const companies = COMPANIES.map(([name, domain, industry, country, employee_count, founded, jobs], i) => ({
  id: `cmp_${String(i + 1).padStart(3, "0")}`,
  name,
  domain,
  industry,
  country,
  employee_count,
  founded,
  jobs: jobs.map(([title, role], j) => ({ id: `job_${i + 1}_${j + 1}`, title, role })),
}));
