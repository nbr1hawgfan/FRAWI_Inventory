/* The only file that changes per customer.
   To make an app for another customer: copy this repo, change these values,
   and add the customer row in Supabase (see README). */
window.APP_CONFIG = {
  customer: "FRAWI",                        // WMS customer code (must exist in cust_app_customers)
  title: "Franklin Inventory",              // header + browser tab
  shortTitle: "Franklin Inventory",         // home-screen icon label
  fileBase: "Franklin",                     // Excel file names start with this
  api: "https://tjivcqxnkftujceumdtx.supabase.co/functions/v1/customer-app",
  weather: { lat: 35.3859, lon: -94.3985, place: "Fort Smith" }   // header time, temperature and forecast
};
