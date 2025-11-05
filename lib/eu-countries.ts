/**
 * List of EU country codes (ISO 3166-1 alpha-2)
 * Used to determine if customs declaration is required
 */
export const EU_COUNTRIES = [
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czech Republic
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
] as const;

/**
 * Check if a country code is outside the EU (requires customs declaration)
 * @param countryCode - ISO 3166-1 alpha-2 country code (e.g., 'US', 'GB', 'IT')
 * @returns true if customs declaration is required (non-EU country)
 */
export function requiresCustomsDeclaration(countryCode: string): boolean {
  if (!countryCode) return false;
  const code = countryCode.trim().toUpperCase();
  return !EU_COUNTRIES.includes(code as any);
}

/**
 * Check if a country is in the EU
 * @param countryCode - ISO 3166-1 alpha-2 country code
 * @returns true if country is in the EU
 */
export function isEUCountry(countryCode: string): boolean {
  if (!countryCode) return false;
  const code = countryCode.trim().toUpperCase();
  return EU_COUNTRIES.includes(code as any);
}
