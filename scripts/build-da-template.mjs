// Builder for the Driving Academy public form template (id: tmpl-driving-academy-da-epd).
//
// 2026-06-19: rebuilt from "SB DA + clients rights.pdf" — the DA
// Referral/Registration form + Springboard Client Rights Policy (Appendix 1).
// This SUPERSEDES the earlier DA+EPD form: the new form drops the entire
// EPD / MSD-eligibility block and the Privacy Declaration, and surfaces the
// top-of-form "Date" (registration-date). Same template id is reused (in-place
// swap), so existing minted links and the mint-form-token staticParam keep
// working. The model is already a superset of these fields — no fact/model edit
// is required (verified against da-nzta-enrollment.json). The previous DA+EPD
// builder is preserved in git history.
//
// Labels + Client Rights Policy prose are verbatim from the PDF; branding uses
// the real Springboard palette (black ink + #FDCB01 yellow).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Reuse the verified Springboard logo data URI. Tolerate its absence so the
// build still produces a (logo-less) template on a box without the source file.
let logoUri;
try {
  logoUri = fs
    .readFileSync('C:/Users/arjan/Downloads/springboard-logo.datauri.txt', 'utf8')
    .trim();
} catch {
  console.warn('[warn] springboard-logo.datauri.txt not found — building without logoUrl');
  logoUri = undefined;
}

const COMPOSITE = 'fact-applformmqbp5d6c'; // application-form (composite)
const APPLICANT = 'fact-uig726p2k'; // applicant-id (system-assigned)

// helper: a composite sub-field ref
const sf = (subField, label, opts = {}) => ({ factId: COMPOSITE, subField, label, ...opts });

// registration-date is a sub-field of the application-form composite (folded).
// It arrives as external input on the form submission, so the form shows it as a
// plain editable Date field — the model does not assign it.
const dateField = sf('registration-date', 'Date', { colSpan: 1 });

const clientRightsPolicy =
  'Springboard Client Rights Policy\n\n' +
  'Purpose: The purpose of this policy is for staff and clients to understand their rights within our organisation.\n\n' +
  "Scope: This policy refers to each individual's rights (legally and morally), not the rights and entitlements of other clients.\n\n" +
  'Aims: This provides understanding for clients and employees of their rights.\n\n' +
  'Our clients have a right to:\n' +
  '1. Be treated fairly with respect and without pressure or discrimination.\n' +
  '2. Have their cultural and religious beliefs respected.\n' +
  '3. Dignity and independence and to receive a quality service and to be treated with care and skill.\n' +
  '4. Be given the information they need to know about their support; the service being provided and the names and roles of the staff; as well as information about any additional services they may need or be encouraged to use.\n' +
  '5. Make their own decisions about support, and to change their mind.\n' +
  '6. Complain and have their complaint taken seriously.\n' +
  '7. Request any information held by Springboard about them.\n' +
  '8. Know when and why their information is being collected.\n' +
  '9. Have all these rights apply if they are asked to take part in a research study or teaching session for the purposes of training staff.\n\n' +
  'Legislation & research related to this policy — this Springboard policy includes key elements of the following legislation, but does not exclude other legislation:\n' +
  "• Vulnerable Children's Act 2014\n" +
  '• Privacy Act 2020\n' +
  '• Human Rights Act 1993\n' +
  '• Youth Worth Code of Ethics';

const template = {
  displayName: 'Driving Academy — Referral / Registration',
  activityId: 'activity-lfd9egi97',
  externalOutcomeName: 'application-form-submitted',
  eventType: 'application-form-submitted',
  requiresSignature: true,
  branding: {
    ...(logoUri ? { logoUrl: logoUri } : {}),
    organisationName: 'Springboard',
    tagline: 'Driving Academy · Heart at Work',
    accentColor: '#FDCB01', // Springboard yellow — rules, bars, highlights
    buttonColor: '#141414', // black — submit + section number badges
    backgroundColor: '#e7e7e7',
    footer:
      'The information you provide is collected by Springboard to process your Driving Academy referral and registration, and is handled in accordance with the Privacy Act 2020. By submitting and signing, you confirm the details are true and complete.',
  },
  sections: [
    {
      id: 'reference',
      title: 'Your registration',
      fields: [
        {
          factId: APPLICANT,
          label: 'Application ID',
          helpText: 'Your reference number — quote this in any correspondence.',
          readOnly: true,
          colSpan: 1,
        },
      ],
    },
    {
      id: 'client-details',
      title: 'Client Details',
      fields: [
        dateField,
        sf('full-name', 'Full Name', { required: true }),
        sf('date-of-birth', 'Date of Birth', { colSpan: 1, required: true }),
        sf('gender', 'Gender', { colSpan: 1 }),
        sf('school', 'School (if applicable)', { colSpan: 1 }),
        sf('ethnicity', 'Ethnicity', { colSpan: 1 }),
        sf('phone', 'Phone', { colSpan: 1 }),
        sf('mobile', 'Mobile', { colSpan: 1 }),
        sf('address', 'Address'),
        sf('email', 'Email', { required: true }),
      ],
    },
    {
      id: 'emergency-contact',
      title: 'Emergency Contact',
      fields: [sf('emergency-contact', 'Emergency contact')],
    },
    {
      id: 'declaration',
      title: 'Declaration',
      intro: clientRightsPolicy,
      fields: [
        sf(
          'photo-consent',
          'I give permission for photos taken of me during my time with Driving Academy to be used for marketing/promotional material',
        ),
        sf(
          'medical-conditions',
          'Medical conditions to note prior to driving (include prescription glasses)',
        ),
        sf(
          'rights-policy-acknowledged',
          'I have been informed of the Clients Rights Policy',
        ),
      ],
    },
    {
      id: 'current-licence',
      title: 'Current Drivers Licence',
      fields: [
        sf('current-licence', 'Current Drivers Licence', { colSpan: 1 }),
        sf('licence-sighted-by-coach', 'Sighted by Coach', { colSpan: 1 }),
        sf('licence-number', 'Licence Number', { colSpan: 1 }),
        sf('licence-issue-date', 'Issue Date', { colSpan: 1 }),
      ],
    },
    {
      id: 'signature',
      title: 'Signature',
      intro: 'Please sign below to confirm your registration.',
      fields: [
        // Routing-only: captured by the dedicated signature pad, filtered from
        // display by the runner — lands the PNG at application-form.signature-png.
        sf('signature-png', 'Signature'),
      ],
    },
  ],
};

// Co-located with the DA model — mirrors the org-repo layout
// (models/<model-id>/da-nzta-enrollment/forms/), which syncs to
// skills/da-nzta-enrollment/forms/ and resolves via candidateFormPaths.
const outDir = path.join(__dirname, '..', 'skills', 'da-nzta-enrollment', 'forms');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'tmpl-driving-academy-da-epd.json');
fs.writeFileSync(out, JSON.stringify(template, null, 2));
console.log('wrote', out, fs.statSync(out).size, 'bytes');
