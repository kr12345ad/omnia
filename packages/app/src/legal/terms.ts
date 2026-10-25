/**
 * The Terms of Service shown before Omnia can be used. This file is the single
 * source of truth for the text; `packages/desktop/src/main/legal.ts` records the
 * version a user accepted, and a parity test fails when the two versions drift.
 *
 * The version is an ISO date. Bump it whenever any wording changes: every bump
 * forces every installation, including existing ones, to read and accept again.
 */
export const TERMS_VERSION = "2026-10-20"
export const TERMS_EFFECTIVE_DATE = "October 20, 2026"
export const TERMS_CONTACT = "kr12345ad@gmail.com"

export type TermsSection = {
  readonly title: string
  readonly paragraphs?: readonly string[]
  readonly bullets?: readonly string[]
}

export const TERMS_PREAMBLE: readonly string[] = [
  `These Terms of Service ("Terms") are a binding agreement between you ("you", "your") and the operator of Omnia ("Omnia", "we", "us") governing your installation and use of the Omnia desktop application, its local server, command-line tools, agents, and any update, add-on, or documentation we make available (together, the "Software").`,
  `Read these Terms in full before you continue. By selecting "I agree", by signing in, or by otherwise using the Software, you accept these Terms and the version shown here (${TERMS_VERSION}, effective ${TERMS_EFFECTIVE_DATE}). If you do not accept them, do not use the Software, and uninstall it.`,
  `If you use the Software on behalf of an organization, you represent that you are authorized to accept these Terms for that organization and that "you" includes it. If you are not authorized, you may not use the Software.`,
]

export const TERMS_SECTIONS: readonly TermsSection[] = [
  {
    title: "1. Acceptance, scope, and existing installations",
    paragraphs: [
      "These Terms apply to every installation of the Software, whether you installed it today or have used it for months. They replace any earlier terms, licence, or notice that accompanied a previous version of the Software.",
      "Acceptance is a precondition of use, not a formality. The Software blocks its interface until the current version of these Terms has been accepted. Acceptance is recorded locally with the accepted version and a timestamp. If the version changes, the block returns and you must accept the new version before you can continue; history, settings, and sessions are preserved while the block is shown, but the Software will not run the agent, open a session, or start its local server until you accept.",
      "Each version of these Terms is identified by its effective date. The version you accepted is the version that governs your use until a later version is accepted. Continued use after a new version is presented is not possible without accepting it, so there is no implied acceptance by silence.",
    ],
  },
  {
    title: "2. Eligibility",
    paragraphs: [
      "You must be at least 18 years old, or the age of majority where you live if that is higher, and legally able to enter into a contract. You must not be barred from using the Software under the laws of your jurisdiction or under any sanctions, export-control, or anti-terrorism list that applies to you.",
      "You must not use the Software if we have terminated your access or banned your installation, unless we have lifted the ban in writing.",
    ],
  },
  {
    title: "3. Licence",
    paragraphs: [
      "Subject to your compliance with these Terms, we grant you a personal, limited, non-exclusive, non-transferable, revocable licence to install and run the Software on devices you own or control, for your own use or the internal business use of the organization that authorized you.",
      "The Software is licensed, not sold. We and our licensors retain all right, title, and interest in the Software, including its source code, interface, design, documentation, and marks. No rights are granted except those expressly stated here.",
      "You may not (a) sell, rent, sublicense, distribute, or make the Software available to third parties as a service; (b) remove or alter proprietary notices; (c) reverse engineer, decompile, or disassemble the Software except to the extent that applicable law expressly permits it despite this restriction; (d) circumvent, disable, or interfere with licensing, telemetry, ban, encryption, or security mechanisms; (e) use the Software to build a competing product by extracting its models, prompts, or agent definitions; or (f) use the Software in a way that violates the terms of any third-party service, model provider, or API it connects to.",
    ],
  },
  {
    title: "4. Your installation, accounts, and credentials",
    paragraphs: [
      "The Software runs primarily on your computer. Its local server binds to loopback, and the data it creates lives in your user profile. You are responsible for the device, the operating system, the user account, and physical access to the machine.",
      "Where the Software connects to a hosted account or control plane, you are responsible for keeping credentials confidential and for every action taken through your account. Notify us promptly at the contact address below if you believe your credentials were compromised.",
      "Provider keys, OAuth tokens, and passwords you supply are stored on your machine using the strongest mechanism the operating system offers. You are responsible for the consequences of keys you choose to store, including spend incurred with third-party providers.",
    ],
  },
  {
    title: "5. AI behaviour is probabilistic",
    paragraphs: [
      "The Software orchestrates large language models and other AI systems. Their output is probabilistic, may be incomplete, outdated, or wrong, and may produce code, commands, or actions that are unsafe in your environment. You must review output before relying on it, and you must keep backups of anything you cannot afford to lose.",
      "The Software is not a licensed professional. It does not provide legal, medical, financial, tax, or security advice, and nothing it produces is a substitute for a qualified professional. You are solely responsible for decisions you take on the basis of its output.",
      "When you enable agents that operate the computer, the Software can move the pointer, type, open applications, run commands, and read the screen. Those actions are real. You are responsible for supervising them, for the permissions you grant, and for the accounts and machines you expose to them.",
    ],
  },
  {
    title: "6. Acceptable use",
    paragraphs: [
      "You must use the Software lawfully and only for purposes you are authorized to pursue. Without limiting that obligation, you must not use the Software to:",
    ],
    bullets: [
      "access, modify, or exfiltrate systems, accounts, files, or data without the owner's informed permission, including by guessing, harvesting, or reusing credentials;",
      "create, distribute, or run malware, ransomware, spyware, stalkerware, botnets, credential stealers, or any code designed to damage, surveil, or gain unauthorized access;",
      "defraud, phish, impersonate, harass, threaten, defame, or discriminate against any person or group;",
      "generate or distribute content that sexualizes minors, incites violence, or violates applicable law;",
      "infringe intellectual property, breach confidentiality, or violate privacy or data-protection law, including by processing personal data without a lawful basis;",
      "circumvent security controls, rate limits, paywalls, bans, or access restrictions of any service, including this one;",
      "send spam, run undisclosed automated engagement, or manipulate rankings, reviews, or markets;",
      "perform high-impact automated decisions about people (employment, credit, housing, health, education, or access to essential services) without human review and a lawful basis;",
      "operate weapons, critical infrastructure, or safety-critical systems where failure could cause injury or significant harm.",
    ],
  },
  {
    title: "7. Computer control and privileged actions",
    paragraphs: [
      "Computer-control features can act with the privileges of your user account. If you grant elevated rights, enable auto-accept, or expose a remote computer, the Software may act without a per-action confirmation. You must scope permissions as narrowly as your work allows, keep unattended machines isolated, and never leave an agent running on a machine you do not control.",
      "You are responsible for every command, purchase, message, deletion, and configuration change an agent performs under your account, whether or not you watched it happen.",
    ],
  },
  {
    title: "8. Your content and your data",
    paragraphs: [
      "You retain all rights in the prompts, files, sessions, and other material you provide or create with the Software. You grant us only the limited rights needed to operate the Software for you: to process your input locally, to send the parts of it you choose to the model or service you selected, and to store results on your device.",
      "You are responsible for having the right to submit whatever you submit. Do not submit personal data of others, regulated data, or confidential material unless you are authorized to do so and have configured the Software appropriately.",
      "The Software sends data to third-party model providers only when you use features that require them, under the credentials and configuration you choose. Their handling of that data is governed by their terms and privacy policies, not by these Terms. Some features may be unavailable when you disable telemetry, decline a provider, or work offline.",
    ],
  },
  {
    title: "9. Local storage, encryption, and retention",
    paragraphs: [
      "Sessions, messages, settings, imported history, and agent artifacts are stored in your user profile on this computer. You control that data and may delete it at any time. We do not receive a copy unless you explicitly export or transmit it.",
      "The local database is not encrypted while the Software runs normally, because the agent must read it continuously. If your installation is banned, or if you ask the Software to seal your data, the session database is encrypted at rest with authenticated encryption (AES-256-GCM) and the plaintext copy is removed. Sealing is not deletion: the encrypted file remains on disk, and it is restored when a ban is lifted.",
      "The key material that protects a sealed database is stored on your machine, outside the application's own data folder, so that uninstalling and reinstalling the Software cannot silently discard your history. Anyone with full access to your operating-system account and enough technical skill can recover that key material. Sealing protects against casual access, accidental disclosure, and a ban that survives reinstallation; it is not a defence against a determined local administrator.",
      "Diagnostic logs may contain file paths, command text, and error details. Review them before sharing them, and use the built-in export rather than copying raw log directories.",
    ],
  },
  {
    title: "10. Bans and enforcement",
    paragraphs: [
      "We may suspend or ban an installation from using the Software if we reasonably believe it has been used in breach of these Terms, to attack or defraud another person or service, to evade an earlier enforcement action, or in a way that creates legal, security, or operational risk. A ban may be applied to a device, an installation, an account, or a person.",
      "A ban is enforced by the Software itself. When a ban takes effect, the interface is replaced by a notice that states the reason and the appeal route; agents, sessions, the local server, and model access are unavailable; and the session database is sealed as described in section 9. The ban marker is stored in several locations outside the application's data folder, so uninstalling the Software, deleting its data directory, reinstalling, or installing a different version does not lift it. Reusing a licence, creating a new account, or changing provider credentials does not lift it either.",
      "Bans are not intended to destroy your work. The sealed database remains on your device, and lifting the ban restores it, including sessions, settings, and imported history. We may nonetheless apply a ban in a way that withholds access indefinitely if the conduct is severe or unlawful.",
      "You may appeal a ban by writing to " +
        TERMS_CONTACT +
        " from the address associated with your use of the Software, including the installation fingerprint shown on the ban notice and any explanation you want considered. Appeals are reviewed manually. We may lift a ban, shorten it, attach conditions, or refuse it. Attempting to evade enforcement while an appeal is pending is itself a ground for refusal.",
      "Deliberately disabling, editing, or spoofing the ban mechanism, its markers, its fingerprint, or its network checks is a material breach of these Terms and may result in a permanent ban and, where appropriate, a report to the relevant authorities.",
    ],
  },
  {
    title: "11. Telemetry and usage reporting",
    paragraphs: [
      "The Software may send limited operational data to the control plane or account you configured, such as whether a turn completed, model identifiers, token counts, and version information. This is used for entitlements, limits, abuse prevention, and support. Where a build has telemetry disabled, that reporting is disabled along with it.",
      "Ban checks may contact an enforcement endpoint with a one-way fingerprint of your installation. No session content, prompts, or files are included in that check. If the check cannot reach the endpoint, the Software continues to work; a locally recorded ban still applies.",
    ],
  },
  {
    title: "12. Third-party software, services, and models",
    paragraphs: [
      "The Software bundles or connects to third-party components, model providers, package registries, browsers, and operating-system features. Those components are governed by their own licences and terms. We do not control them and are not responsible for their availability, behaviour, output, or charges.",
      "You must comply with the terms of every provider you connect, including rate limits, acceptable-use rules, and restrictions on automated access. If a provider suspends you, that is between you and the provider.",
    ],
  },
  {
    title: "13. Updates and changes to the Software",
    paragraphs: [
      "The Software may download and install updates, or prompt you to do so. Updates may add, change, or remove features, and may change these Terms. Where a changed version of these Terms applies, the Software presents it for acceptance before further use, as described in section 1.",
      "We may also change, suspend, or discontinue the Software or any part of it. Where a paid entitlement is affected, we will not charge for a period in which the paid feature is unavailable.",
    ],
  },
  {
    title: "14. Fees, trials, and entitlements",
    paragraphs: [
      "Some features require a paid entitlement or a provider account that you pay for directly. Prices, limits, and included quotas are those shown at the point of purchase or in the connected console. Third-party provider charges are yours and are not refundable by us.",
      "Unless applicable law requires otherwise, fees already paid are non-refundable. If we terminate your access for convenience and not because of your breach, we will refund the unused portion of any prepaid period.",
    ],
  },
  {
    title: "15. Availability and support",
    paragraphs: [
      "The Software is provided on an as-available basis. Local features depend on your hardware, operating system, permissions, and network. Hosted features may be interrupted for maintenance, security, or reasons outside our control. We do not guarantee uninterrupted or error-free operation, and we do not guarantee that any model, provider, integration, or model download will remain available.",
      "Support is provided at our discretion through the published channels. Do not send secrets, private keys, or personal data of others in a support request.",
    ],
  },
  {
    title: "16. Intellectual property and feedback",
    paragraphs: [
      "The Software, its design, and its documentation are protected by copyright, trademark, and other laws. These Terms grant no trademark or branding rights. You may not use our name or logo to imply endorsement without written permission.",
      "If you send us feedback, suggestions, or bug reports, you grant us a perpetual, irrevocable, royalty-free licence to use them to improve the Software, without obligation to you. Do not send ideas you need to keep confidential or to be paid for.",
    ],
  },
  {
    title: "17. Term, termination, and survival",
    paragraphs: [
      "These Terms apply from the moment you accept them until terminated. You may terminate by uninstalling the Software and deleting your local data. We may terminate or suspend your licence for breach of these Terms, for legal or security reasons, or if we discontinue the Software.",
      "On termination, your licence ends immediately. Sections that by their nature should survive — including ownership, disclaimers, limitation of liability, indemnity, governing law, and the ban and enforcement provisions — survive termination.",
    ],
  },
  {
    title: "18. Disclaimers",
    paragraphs: [
      'TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING ANY IMPLIED WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, OR THAT OUTPUT WILL BE ACCURATE, LAWFUL, OR SUITABLE FOR YOUR USE.',
      "We do not warrant that the Software will be free of defects, that it will not lose or corrupt data, that it will detect every security problem, or that any AI output will be correct. You use the Software at your own risk, and you are responsible for backups and for verifying anything you deploy.",
      "Some jurisdictions do not allow the exclusion of certain warranties. In those jurisdictions, the exclusions apply only to the extent permitted, and nothing in these Terms excludes a warranty that cannot lawfully be excluded.",
    ],
  },
  {
    title: "19. Limitation of liability",
    paragraphs: [
      "TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, DATA, GOODWILL, OR BUSINESS OPPORTUNITY, ARISING OUT OF OR RELATING TO THE SOFTWARE OR THESE TERMS, EVEN IF WE WERE ADVISED OF THE POSSIBILITY.",
      "OUR TOTAL LIABILITY FOR ALL CLAIMS ARISING OUT OF OR RELATING TO THE SOFTWARE OR THESE TERMS WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US FOR THE SOFTWARE IN THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM, OR (B) FIFTY US DOLLARS.",
      "Nothing in these Terms limits liability for fraud, wilful misconduct, death or personal injury caused by negligence, or any liability that cannot be limited by law. Because the Software can control your computer, you acknowledge that you are responsible for scoping permissions, supervising agents, and maintaining backups.",
    ],
  },
  {
    title: "20. Indemnity",
    paragraphs: [
      "You will defend and indemnify us, our licensors, and our contractors against claims, damages, losses, and expenses (including reasonable legal fees) arising from your use of the Software, your content, your breach of these Terms, or your violation of another person's rights or applicable law.",
    ],
  },
  {
    title: "21. Export, sanctions, and restricted use",
    paragraphs: [
      "You may not use the Software in a country subject to comprehensive sanctions, or if you are on a restricted-party list. You may not use it for the design, development, or production of weapons, for unauthorized access to critical infrastructure, or for any purpose prohibited by export-control law.",
    ],
  },
  {
    title: "22. Governing law and disputes",
    paragraphs: [
      "These Terms are governed by the laws applicable at the operator's principal place of business, without regard to conflict-of-law rules. Mandatory consumer protections in your country of residence continue to apply where they cannot be waived.",
      "Before starting formal proceedings, contact us at " +
        TERMS_CONTACT +
        " and allow thirty days to resolve the issue informally. Claims must be brought in the courts with jurisdiction over the operator's principal place of business, unless the law where you live gives you the right to sue locally.",
      "Nothing in this section prevents either party from seeking urgent injunctive relief to protect intellectual property, security, or the integrity of the enforcement system.",
    ],
  },
  {
    title: "23. Changes to these Terms",
    paragraphs: [
      "We may update these Terms. The current version is always the one presented by the Software, identified by its effective date. A material change is presented for acceptance before you can continue using the Software, and the previous version remains available on request.",
      "If you do not accept a new version, you may stop using the Software; your local data remains on your device, and you may export it before uninstalling.",
    ],
  },
  {
    title: "24. General",
    paragraphs: [
      "These Terms are the entire agreement between us about the Software and supersede any prior or contemporaneous understanding on the same subject. If a provision is found unenforceable, it is limited or severed to the minimum extent necessary and the remaining provisions stay in force. A failure to enforce a provision is not a waiver. You may not assign these Terms; we may assign them to an affiliate or in connection with a merger, acquisition, or sale of assets.",
      "Headings are for convenience only. References to a statute or regulation include its successors. Where these Terms conflict with a signed enterprise agreement that covers your organization, that agreement controls to the extent of the conflict.",
    ],
  },
  {
    title: "25. Contact",
    paragraphs: [
      `Questions about these Terms, requests for a previous version, ban appeals, and legal notices go to ${TERMS_CONTACT}. Include the version you are asking about (${TERMS_VERSION}) and, for ban appeals, the installation fingerprint shown on the ban notice.`,
      "We aim to answer legal and appeal correspondence within ten business days.",
    ],
  },
]
