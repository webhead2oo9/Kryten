export interface CandidateDecision {
    candidate: boolean;
    reasons: string[];
}

const SUPPORT_INTENT =
    /\?|\b(?:help|how|why|where|what|when|can|could|does|do|is|are|anyone|issue|problem|broken|fail(?:ed|ing)?|cannot|can't|cant|won't|wont|unable|missing|stuck|spinner|spinning|forever|still (?:on|shows?|running)|only shows?|not showing|not working|disconnect(?:ion)?s?|disconnected|disconnecting|drops?|freez(?:e|es|ing)|frozen|stutter(?:s|ing)?|crash(?:es|ed|ing)?|latency|lag|black screen|no usb|no wired)\b/i;
const VD_CONTEXT = /\b(?:virtual desktop|vd|streamer|headset app)\b/i;
const USB_MODE = /\b(?:usb(?:\s+ncm)?|ncm|wired|cabled|link cable|on cable|via cable|over cable)\b/i;
const USB_KEYWORD = /\b(?:beta\s+usb\s+setup|usb\s+cable)\b/i;
const CONNECTION_OR_PERFORMANCE =
    /\b(?:connect(?:ion|ed|ing)?|detect(?:ed|ing)?|recogniz(?:e|ed|ing)|show(?:s|ing)?|tag|mode|wired|wi-?fi|stream(?:ing)?|disconnect(?:ion)?s?|disconnected|disconnecting|drops?|freez(?:e|es|ing)|frozen|stutter(?:s|ing)?|crash(?:es|ed|ing)?|latency|lag|bitrate|black screen|unreachable|restart(?:s|ed|ing)?)\b/i;
const FIFTEEN_MINUTE = /\b(?:(?:15|fifteen)\s*(?:min(?:ute)?s?)|quarter\s+hour)\b/i;
const FIFTEEN_MINUTE_EFFECT = /\b(?:restart|reset|black(?: screen)?|hitch|freeze|frozen|disconnect|drop|stutter)\w*/i;

const NETWORK_ONLY =
    /\b(?:ethernet|usb[- ]?to[- ]?ethernet|dongle|router|access point|\bap\b|cat[5-8]|lan cable|network switch|internet connection sharing|\bics\b)\b/i;
const LINK_ONLY = /\b(?:meta link|oculus link|air link|quest link)\b/i;
const PERIPHERAL =
    /\b(?:flight stick|joystick|gamepad|xbox controller|controller forwarding|keyboard|mouse|steering wheel|pedals?|webcam|capture card|usb microphone|virtual audio cable)\b/i;
const CHARGING_OR_SHOPPING =
    /\b(?:charg(?:e|er|ing)|battery|power bank|power injection|headstrap|which cable|buy a cable|cable recommendation)\b/i;

export function betaCandidateDecision(text: string): CandidateDecision {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized || !SUPPORT_INTENT.test(normalized)) return { candidate: false, reasons: [] };

    const ncm = /\b(?:usb\s+ncm|ncm)\b/i.test(normalized);
    const connectionIssue = CONNECTION_OR_PERFORMANCE.test(normalized);
    const usbMode = USB_MODE.test(normalized);
    const vdContext = VD_CONTEXT.test(normalized);
    const headsetContext = /\b(?:quest|headset|pc)\b/i.test(normalized);
    const terseCabledIssue =
        /\b(?:on cabled|on cable|cabled|wired|via usb|over usb)\b/i.test(normalized) && connectionIssue;
    const directUsb = usbMode && connectionIssue && (vdContext || headsetContext || terseCabledIssue);
    const usbKeyword = USB_KEYWORD.test(normalized);
    const usbBetaSetup =
        /\bbeta\b/i.test(normalized) &&
        /\busb\b/i.test(normalized) &&
        /\b(?:install|download|update|switch|select|find|option|channel|setup)\w*/i.test(normalized);
    const fifteenMinuteRestart = FIFTEEN_MINUTE.test(normalized) && FIFTEEN_MINUTE_EFFECT.test(normalized);

    if (NETWORK_ONLY.test(normalized) && !ncm) return { candidate: false, reasons: ["network-only"] };
    if (LINK_ONLY.test(normalized) && !vdContext) return { candidate: false, reasons: ["meta-link-only"] };
    if (PERIPHERAL.test(normalized)) return { candidate: false, reasons: ["peripheral"] };
    if (CHARGING_OR_SHOPPING.test(normalized) && !connectionIssue) {
        return { candidate: false, reasons: ["charging-or-shopping"] };
    }

    const reasons: string[] = [];
    if (ncm) reasons.push("usb-ncm");
    if (fifteenMinuteRestart) reasons.push("fifteen-minute-restart");
    if (directUsb) reasons.push("direct-usb-context");
    if (usbKeyword) reasons.push("usb-keyword");
    if (usbBetaSetup) reasons.push("usb-beta-setup");
    return { candidate: reasons.length > 0, reasons };
}
