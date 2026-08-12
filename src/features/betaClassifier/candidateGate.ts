export interface CandidateDecision {
    candidate: boolean;
    reasons: string[];
}

const SUPPORT_INTENT =
    /\?|\b(?:help|how|why|where|what|when|can|could|does|do|is|are|anyone|issue|problem|broken|fail(?:ed|ing)?|cannot|can't|cant|won't|wont|unable|missing|stuck|spinner|spinning|forever|still (?:on|shows?|running)|only shows?|not showing|not working|disconnect(?:ion)?s?|disconnected|disconnecting|drops?|freez(?:e|es|ing)|frozen|stutter(?:s|ing)?|crash(?:es|ed|ing)?|latency|lag|black screen|no usb|no wired)\b/i;
const VD_CONTEXT = /\b(?:virtual desktop|vd|streamer|headset app)\b/i;
const ACTIVE_VERSION = /\b1\.34\.20\b/i;
const BETA_CONTEXT = /\b(?:beta streamer|vd beta|virtual desktop beta|beta release channel|beta channel)\b/i;
const USB_MODE = /\b(?:usb(?:\s+ncm)?|ncm|wired|cabled|on cable|via cable|over cable)\b/i;
const USB_KEYWORD = /\b(?:beta\s+usb\s+setup|usb\s+cable)\b/i;
const CONNECTION_OR_PERFORMANCE =
    /\b(?:connect(?:ion|ed|ing)?|detect(?:ed|ing)?|recogniz(?:e|ed|ing)|show(?:s|ing)?|tag|mode|wired|wi-?fi|stream(?:ing)?|disconnect(?:ion)?s?|disconnected|disconnecting|drops?|freez(?:e|es|ing)|frozen|stutter(?:s|ing)?|crash(?:es|ed|ing)?|latency|lag|bitrate|black screen|unreachable|restart(?:s|ed|ing)?)\b/i;
const TWELVE_MINUTE = /\b(?:12|twelve)(?:\.5)?\s*(?:min(?:ute)?s?)\b/i;
const TWELVE_MINUTE_EFFECT = /\b(?:restart|reset|black screen|hitch|freeze|frozen|disconnect|drop|stutter)\w*/i;

const NETWORK_ONLY =
    /\b(?:ethernet|usb[- ]?to[- ]?ethernet|dongle|router|access point|\bap\b|cat[5-8]|lan cable|network switch|internet connection sharing|\bics\b)\b/i;
const LINK_ONLY = /\b(?:meta link|oculus link|air link|quest link)\b/i;
const PERIPHERAL =
    /\b(?:flight stick|joystick|gamepad|xbox controller|controller forwarding|keyboard|mouse|steering wheel|pedals?|webcam|capture card|usb microphone|virtual audio cable)\b/i;
const CHARGING_OR_SHOPPING =
    /\b(?:charg(?:e|er|ing)|battery|power bank|power injection|headstrap|which cable|buy a cable|cable recommendation)\b/i;
const OTHER_BETA = /\b(?:quest ptc|meta ptc|quest os beta|steamvr beta|nvidia beta|amd beta|game beta)\b/i;

export function betaCandidateDecision(text: string): CandidateDecision {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || !SUPPORT_INTENT.test(normalized)) return { candidate: false, reasons: [] };

    const version = ACTIVE_VERSION.test(normalized);
    const betaKeyword = /\bbeta\b/i.test(normalized);
    const explicitBeta = BETA_CONTEXT.test(normalized) || (/\bbeta\b/i.test(normalized) && VD_CONTEXT.test(normalized));
    const betaInstall =
        betaKeyword &&
        /\b(?:install|download|update|switch|select|find|option|channel|version|setup|1\.34\.(?:18|19))\w*/i.test(
            normalized,
        );
    const betaFeature =
        /\bbeta\b/i.test(normalized) &&
        /\b(?:96|100)\s*fps\b|\b(?:graphics quality|render resolution)\b/i.test(normalized);
    const ncm = /\b(?:usb\s+ncm|ncm)\b/i.test(normalized);
    const twelveMinute = TWELVE_MINUTE.test(normalized) && TWELVE_MINUTE_EFFECT.test(normalized);
    const connectionIssue = CONNECTION_OR_PERFORMANCE.test(normalized);
    const usbMode = USB_MODE.test(normalized);
    const vdContext = VD_CONTEXT.test(normalized);
    const headsetContext = /\b(?:quest|headset|pc)\b/i.test(normalized);
    const terseCabledIssue =
        /\b(?:on cabled|on cable|cabled|wired|via usb|over usb)\b/i.test(normalized) && connectionIssue;
    const directUsb = usbMode && connectionIssue && (vdContext || headsetContext || terseCabledIssue);
    const usbKeyword = USB_KEYWORD.test(normalized);
    const strongBetaEvidence =
        version || betaKeyword || explicitBeta || betaInstall || betaFeature || ncm || twelveMinute || usbKeyword;

    if (OTHER_BETA.test(normalized) && !vdContext && !version) {
        return { candidate: false, reasons: ["other-beta"] };
    }

    if (!strongBetaEvidence) {
        if (NETWORK_ONLY.test(normalized)) return { candidate: false, reasons: ["network-only"] };
        if (LINK_ONLY.test(normalized) && !vdContext) return { candidate: false, reasons: ["meta-link-only"] };
        if (PERIPHERAL.test(normalized)) return { candidate: false, reasons: ["peripheral"] };
        if (CHARGING_OR_SHOPPING.test(normalized) && !connectionIssue) {
            return { candidate: false, reasons: ["charging-or-shopping"] };
        }
    }

    const reasons: string[] = [];
    if (version) reasons.push("active-version");
    if (betaKeyword) reasons.push("beta-keyword");
    if (explicitBeta) reasons.push("explicit-vd-beta");
    if (betaInstall) reasons.push("beta-install");
    if (betaFeature) reasons.push("beta-feature");
    if (ncm) reasons.push("usb-ncm");
    if (twelveMinute) reasons.push("twelve-minute-restart");
    if (directUsb) reasons.push("direct-usb-context");
    if (usbKeyword) reasons.push("usb-keyword");
    return { candidate: reasons.length > 0, reasons };
}
