/**
 * Hệ thống Căn ăn mức - Lọc trùng & Tính toán số dư
 */

function formatInputMessage(text) {
    var lines = text.split("\n");
    var formattedLines = [];
    var wasFormatted = false;
    var errors = [];

    for (var l = 0; l < lines.length; l++) {
        var formatted = lines[l];
        var prev;

        // Rule: daoxcdui → xduoidao, daoxcdau → xdaudao
        prev = formatted;
        formatted = formatted.replace(/daoxcdui/gi, "xduoidao");
        formatted = formatted.replace(/daoxcdau/gi, "xdaudao");
        if (formatted !== prev) wasFormatted = true;

        // Rule: xcdaoduoi/xcdaodui → xduoidao, xcdaodau → xdaudao
        prev = formatted;
        formatted = formatted.replace(/xcdaoduoi/gi, "xduoidao");
        formatted = formatted.replace(/xcdaodui/gi, "xduoidao");
        formatted = formatted.replace(/xcdaodau/gi, "xdaudao");
        if (formatted !== prev) wasFormatted = true;

        // Rule: xcduoidao → xduoidao, xcdaudao → xdaudao
        prev = formatted;
        formatted = formatted.replace(/xcduoidao/gi, "xduoidao");
        formatted = formatted.replace(/xcdaudao/gi, "xdaudao");
        if (formatted !== prev) wasFormatted = true;

        // Rule: duoidao/duidao/daudao → xduoidao/xdaudao (\b prevents matching inside xduoidao/xdaudao)
        prev = formatted;
        formatted = formatted.replace(/\bduoidao/gi, "xduoidao");
        formatted = formatted.replace(/\bduidao/gi, "xduoidao");
        formatted = formatted.replace(/\bdaudao/gi, "xdaudao");
        if (formatted !== prev) wasFormatted = true;

        // Rule: daodui/daoduoi → xduoidao, daodau → xdaudao
        prev = formatted;
        formatted = formatted.replace(/\bdaoduoi/gi, "xduoidao");
        formatted = formatted.replace(/\bdaodui/gi, "xduoidao");
        formatted = formatted.replace(/\bdaodau/gi, "xdaudao");
        if (formatted !== prev) wasFormatted = true;

        // Rule: 'đa'/'đá'/etc → 'da' (normalize Vietnamese đ to ASCII d)
        prev = formatted;
        formatted = formatted.replace(/[đĐ][aáàảãạ]/g, "da");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Replace '+' separator between digits with space
        // e.g. "01+02+08 da1" → "01 02 08 da1"
        prev = formatted;
        formatted = formatted.replace(/(\d)\+(\d)/g, "$1 $2");
        if (formatted !== prev) wasFormatted = true;

        // Rule: For da patterns, convert '/' and '.' between 4+ digit groups to ';'
        // e.g. "6771/7176/7179da2,5" → "6771;7176;7179da2,5"
        // e.g. "6771.7176.7179da2,5" → "6771;7176;7179da2,5"
        if (/\d{4,}[\/.].*da/i.test(formatted)) {
            prev = formatted;
            formatted = formatted.replace(/(\d{4,})[\/.](?=\d{4,})/g, "$1;");
            if (formatted !== prev) wasFormatted = true;
        }

        // Rule: Replace '/' separator between digits with ';'
        // e.g. "00/14/65da1b50" → "00;14;65da1b50"
        prev = formatted;
        formatted = formatted.replace(/(\d)\/(\d)/g, "$1;$2");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Replace ',' separator between multi-digit groups with '.'
        // e.g. "9538,3756b1" → "9538.3756b1"
        // BUT NOT "da0,5" (single digit before comma = decimal amount)
        prev = formatted;
        formatted = formatted.replace(/(\d{2,}),(\d{2,})/g, "$1.$2");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Normalize separators around 'da'
        // e.g. "0110-da1" → "0110 da 1", "77da0'5" → "77 da 0'5", "-da " → " da "
        prev = formatted;
        formatted = formatted.replace(/(\d)\s*-\s*da\s*(\d)/gi, "$1 da $2");
        formatted = formatted.replace(/(\d)\s*-\s*da\b/gi, "$1 da");
        // General: separate digits directly adjacent to 'da' (no dash needed)
        // e.g. "77da0'5" → "77 da 0'5", "3377da1" → "3377 da 1"
        formatted = formatted.replace(/(\d)(da)([0-9,']+)/gi, "$1 da $3");
        formatted = formatted.replace(/(\d)(da)\b/gi, "$1 da");
        if (formatted !== prev) wasFormatted = true;



        // Rule: 'dau duoi' → 'dd'
        prev = formatted;
        formatted = formatted.replace(/dau\s+duoi/gi, "dd");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Province abbreviations with dot/space (B.lieu→blieu, Bl→blieu, B.tre→btre)
        prev = formatted;
        formatted = formatted.replace(/\bB\.?\s*lieu\b/gi, "blieu");
        formatted = formatted.replace(/^Bl\b/i, "blieu");
        formatted = formatted.replace(/\bB\.?\s*tre\b/gi, "btre");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Normalize '.' separator between letters to space
        // e.g. "k tum.k hoa" → "k tum k hoa" (dot used as visual separator, not decimal)
        prev = formatted;
        formatted = formatted.replace(/([a-zA-ZđĐ])\.([a-zA-ZđĐ])/g, "$1 $2");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Province abbreviations
        // 1) Specific common full-name provinces
        prev = formatted;
        formatted = formatted.replace(/\b(ha\s*noi|hanoi|hnoi)\b/gi, "hn");
        formatted = formatted.replace(/\b(hai\s*phong|hphong)\b/gi, "hp");
        formatted = formatted.replace(/\b(ho\s*chi\s*minh|hcm)\b/gi, "hcm");
        formatted = formatted.replace(/\b(da\s*nang|dnang)\b/gi, "dnang");
        formatted = formatted.replace(/\b(kon\s*tum|kontum)\b/gi, "kt");
        formatted = formatted.replace(/\b(khanh\s*hoa|khanhhoa)\b/gi, "kh");
        formatted = formatted.replace(/\b(ben\s*tre|b[.\s]*tre|b[.\s]*tr|btre|btr)\b/gi, "bt");
        formatted = formatted.replace(/\b(vung\s*tau|vtau|v\s+tau)\b/gi, "vt");
        formatted = formatted.replace(/\b(binh\s*duong|bduong)\b/gi, "bd");
        formatted = formatted.replace(/\b(binh\s*dinh|bdinh)\b/gi, "bdi");
        formatted = formatted.replace(/\b(binh\s*phuoc|bphuoc)\b/gi, "bp");
        formatted = formatted.replace(/\b(binh\s*thuan|bthuan)\b/gi, "bth");
        formatted = formatted.replace(/\b(quang\s*ngai|qngai)\b/gi, "qn");
        formatted = formatted.replace(/\b(quang\s*nam|qnam|qna)\b/gi, "qn");
        formatted = formatted.replace(/\b(quang\s*binh|qbinh)\b/gi, "qb");
        formatted = formatted.replace(/\b(quang\s*tri|qtri)\b/gi, "qt");
        formatted = formatted.replace(/\bt[.\s]*ph[ốo]\b/gi, "tp");
        formatted = formatted.replace(/\b(dong\s*nai|d[.\s]+nai|dnai)\b/gi, "dn"); // resolved to dnang/dnai by time in processMessage
        formatted = formatted.replace(/\b(da[ck]\s*n[oô]ng|d[.\s]+n[oô]ng|dn[oô]ng)\b/gi, "dno");
        formatted = formatted.replace(/[đĐ][ắáăa][ck]\s*n[oô]ng/gi, "dno");
        formatted = formatted.replace(/\b(soctrang|soc\s+trang|s[.\s]+trang|strang)\b/gi, "st");
        formatted = formatted.replace(/\b(can\s*tho|can[.\s]+tho|c[.\s]+tho|ctho)\b/gi, "ct");
        if (formatted !== prev) wasFormatted = true;

        // 2) Đ/đ + dot/space + word → d + first letter (e.g. Đ nẵng→dn, đ.nẵng→dn)
        prev = formatted;
        formatted = formatted.replace(/[đĐ][.\s]\s?([a-zA-Z])\S*/g, function (match, p1) {
            return ("d" + p1).toLowerCase();
        });
        if (formatted !== prev) wasFormatted = true;

        // 3) ASCII letter + dot + word → first two letters (e.g. h.noi→hn, t.pho→tp)
        prev = formatted;
        formatted = formatted.replace(/\b([a-zA-Z])\.\s?([a-zA-Z])\S*/gi, function (match, p1, p2) {
            return (p1 + p2).toLowerCase();
        });
        if (formatted !== prev) wasFormatted = true;

        // 4) Single letter + space + word → first two letters (e.g. k tum→kt, k hoa→kh, h noi→hn)
        prev = formatted;
        formatted = formatted.replace(/\b([a-zA-Z])\s+([a-zA-Z])\S*/gi, function (match, p1, p2) {
            // Only match if first part is a single letter (not a known keyword)
            if (/^(b|dd|da|lo|xc)$/i.test(p1)) return match; // skip bet keywords
            return (p1 + p2).toLowerCase();
        });
        if (formatted !== prev) wasFormatted = true;

        // Rule: Remove invalid characters (;:.,@!#$%^&*) stuck to province names after parsing
        // e.g. "hn; 37 b 4" → "hn 37 b 4", "kt: 50 da 1" → "kt 50 da 1"
        // Also handles space before punctuation: "mb ;" → "mb", "mb ; " → "mb "
        prev = formatted;
        formatted = formatted.replace(/([a-zA-Z]{2,})[;:.,@!#$%^&*]+/g, "$1");
        formatted = formatted.replace(/([a-zA-Z]{2,})\s+[;:.,@!#$%^&*]+/g, "$1");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Normalize đ/Đ → d in 2d/3d/4d bet-type suffixes
        // Handles: 2đt→2dt, 3đmn→3dmn, 2 đt→2dt, đt→dt, đmn→dmn, etc.
        prev = formatted;
        formatted = formatted.replace(/([234])\s*[đĐ]/g, "$1d");
        formatted = formatted.replace(/(^|[\s,;])[đĐ](mnt|mn|mt|[nt])/gm, "$1d$2");
        if (formatted !== prev) wasFormatted = true;

        // Rule: 2d/3d/4d suffix stripping (with or without space)
        // Handles: 2dn, 2dt, 2dm, 2dr, 2dnn, 2dmm, 2dmn, 2dmt, 2dmnt, 2dmtr → 2d (same for 3d, 4d)
        // Also: 2nn, 2mm, 3nn, 3mm → 2d, 3d; 2 dn, 2 dt, 3 dmn, 2 d → 2d, 3d
        // Also strips trailing ; : chars (e.g. 2dmn; → 2d, 3dmt: → 3d, 2d; → 2d)
        prev = formatted;
        formatted = formatted.replace(/\b([234])\s+d(mnt|mtr|mn|mt|nn|mm|[mnrt])?\s*[;:]*/gi, "$1d");
        formatted = formatted.replace(/\b2d\s*(mnt|mtr|mn|mt|nn|mm|[mnrt])\s*[;:]*/gi, "2d");
        formatted = formatted.replace(/\b3d\s*(mnt|mtr|mn|mt|nn|mm|[mnrt])\s*[;:]*/gi, "3d");
        formatted = formatted.replace(/\b4d\s*(mnt|mtr|mn|mt|nn|mm|[mnrt])\s*[;:]*/gi, "4d");
        formatted = formatted.replace(/\b([234])(nn|mm|mtr|m[nrt])\s*[;:]*/gi, "$1d");
        formatted = formatted.replace(/\b2m(tr|[nrt])\s*[;:]*/gi, "2d");
        formatted = formatted.replace(/\b3m(tr|[nrt])\s*[;:]*/gi, "3d");
        formatted = formatted.replace(/\b4m(tr|[nrt])\s*[;:]*/gi, "4d");
        // Standalone 2d/3d/4d with trailing ; : (e.g. "2d;" → "2d")
        formatted = formatted.replace(/\b([234]d)[;:]+/gi, "$1");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Insert space between 2d/3d/4d and immediately following digits
        // e.g. "2d785" → "2d 785", "3d123" → "3d 123"
        prev = formatted;
        formatted = formatted.replace(/\b(2d|3d|4d)(\d)/gi, "$1 $2");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Separate digits from bet-type keywords (e.g. 785xdaodau100 → 785 xdaodau 100)
        // Note: 'b\d+' is matched BEFORE standalone 'b' to keep e.g. 'b1', 'b50' as one token
        prev = formatted;
        // Loop to handle adjacent keyword sequences like b100dau100duoi200
        var kwSepPrev;
        do {
            kwSepPrev = formatted;
            formatted = formatted.replace(/(\d)(xduoidao|xdaudao|xdaodau|xdaodui|xdaoduoi|xcdaodui|xcdaodau|xcduoidao|xcdaudao|daoxcdui|daoxcdau|xcdao|xcduoi|xcdui|xcdau|duoidao|duidao|daudao|xdau|xduoi|xdui|daodui|daodau|daoduoi|dd|dau|duoi|dui|xc|da|b7lo|lo|b\d+|b)(\d)/gi, function (m, d1, kw, d2) {
                // If kw already ends with digits (like b1, b50), don't add space after kw
                if (/^b\d+$/i.test(kw)) return d1 + " " + kw + d2;
                return d1 + " " + kw + " " + d2;
            });
        } while (formatted !== kwSepPrev);
        formatted = formatted.replace(/(\d)(xduoidao|xdaudao|xdaodau|xdaodui|xdaoduoi|xcdaodui|xcdaodau|xcduoidao|xcdaudao|daoxcdui|daoxcdau|xcdao|xcduoi|xcdui|xcdau|duoidao|duidao|daudao|xdau|xduoi|xdui|daodui|daodau|daoduoi|dd|dau|duoi|dui|xc|da|b7lo|lo|b\d+|b)$/gi, "$1 $2");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Re-run dao normalization after digit-keyword separation
        // When digits were attached (e.g. 10duoidao30 → 10 duoidao 30), \b now matches
        prev = formatted;
        formatted = formatted.replace(/\bxcdao\b/gi, "xc dao");
        formatted = formatted.replace(/\bduoidao\b/gi, "xduoidao");
        formatted = formatted.replace(/\bduidao\b/gi, "xduoidao");
        formatted = formatted.replace(/\bdaudao\b/gi, "xdaudao");
        formatted = formatted.replace(/\bdaoduoi\b/gi, "xduoidao");
        formatted = formatted.replace(/\bdaodui\b/gi, "xduoidao");
        formatted = formatted.replace(/\bdaodau\b/gi, "xdaudao");
        if (formatted !== prev) wasFormatted = true;

        // Rule: 3-digit number → prefix ALL dau/duoi/daodui/daodau keywords in the same entry with x
        // e.g. "456 dau 30 duoi 10 daodui 10" → "456 xdau 30 xduoi 10 xduoidao 10"
        // BUT NOT when 3-digit number is an amount after a bet keyword (e.g. "dd 150 dau 200" stays as-is)
        // Handles: "hn 191 duoi 20", "hn191duoi20", "191 duoi 20"
        prev = formatted;
        formatted = formatted.replace(/(?:^|(\S+)\s+|([a-zA-Z]+))(\d{3})(?!\d)((?:\s*(?:daodui|daodau|daoduoi|duoi|dui|dau)\s*[\d,.]*)+)/gi, function (m, precedingSpaced, precedingAttached, digits, rest) {
            var preceding = precedingSpaced || precedingAttached || null;
            // If preceded by a bet keyword, this 3-digit number is an amount — don't convert
            if (preceding && /^(xduoidao|xdaudao|xdaodau|xdaodui|xdaoduoi|xcdaodui|xcdaodau|xcduoidao|xcdaudao|daoxcdui|daoxcdau|xcdao|xcduoi|xcdui|xcdau|duoidao|duidao|daudao|xdau|xduoi|xdui|daodui|daodau|daoduoi|dd|dau|duoi|dui|xc|da|b7lo|baylo|lo|b\d+|b)$/i.test(preceding)) return m;
            var converted = rest.replace(/\b(daodui|daodau|daoduoi|duoi|dui|dau)(?=\d|\s|$)/gi, function (kw) {
                var t = kw.toLowerCase();
                if (t === "daodui" || t === "daoduoi") return "xduoidao";
                if (t === "daodau") return "xdaudao";
                if (t === "duoi" || t === "dui") return "xduoi";
                if (t === "dau") return "xdau";
                return kw;
            });
            // Insert space between keyword and attached digits (e.g. "xduoi20" → "xduoi 20")
            converted = converted.replace(/(xduoidao|xdaudao|xduoi|xdau)(\d)/gi, "$1 $2");
            return (preceding ? preceding + ' ' : '') + digits + ' ' + converted.trim();
        });
        if (formatted !== prev) wasFormatted = true;

        // Rule: Split 4+ consecutive digits with 'da' suffix
        // e.g. "8998da0,5" → "89 98 da 0,5"
        prev = formatted;
        formatted = formatted.replace(/(\d{4,})(da)([\d,]+)/gi, function (match, digits, da, value) {
            if (digits.length % 2 !== 0) {
                errors.push("Odd digit count in \"" + match + "\"");
                return match;
            }
            var pairs = [];
            for (var i = 0; i < digits.length; i += 2) {
                pairs.push(digits.substr(i, 2));
            }
            return pairs.join(" ") + " da " + value;
        });
        if (formatted !== prev) wasFormatted = true;

        // Rule: Split 4+ consecutive digits before any bet keyword (b, dd, lo, b7lo, xc, da, etc.)
        // e.g. "008899 b 100" → "00 88 99 b 100"
        prev = formatted;
        formatted = formatted.replace(/(?:(?:^|(?<=\s))(\S+)\s+)?(?<!\.)(?<!\d )(\d{4,})\s+(xduoidao|xdaudao|xdaodau|xdaodui|xdaoduoi|xcdaodui|xcdaodau|xcduoidao|xcdaudao|daoxcdui|daoxcdau|xcdao|xcduoi|xcdui|xcdau|duoidao|duidao|daudao|xdau|xduoi|xdui|daodui|daodau|daoduoi|dd|dau|duoi|dui|xc|da|b7lo|lo|b)\b/gi, function (match, prevWord, digits, kw) {
            // If preceding word is a bet keyword, these digits are an amount — don't split
            if (prevWord && /^(xduoidao|xdaudao|xdaodau|xdaodui|xdaoduoi|xcdaodui|xcdaodau|xcduoidao|xcdaudao|daoxcdui|daoxcdau|xcdao|xcduoi|xcdui|xcdau|duoidao|duidao|daudao|xdau|xduoi|xdui|daodui|daodau|daoduoi|dd|dau|duoi|dui|xc|da|b7lo|lo|b\d*|b)$/i.test(prevWord)) return match;
            if (digits.length % 2 !== 0) {
                errors.push("Odd digit count in \"" + match + "\"");
                return match;
            }
            var pairs = [];
            for (var i = 0; i < digits.length; i += 2) {
                pairs.push(digits.substr(i, 2));
            }
            var result = (prevWord ? prevWord + " " : "") + pairs.join(" ") + " " + kw;
            return result;
        });
        if (formatted !== prev) wasFormatted = true;

        // Rule: Re-run da separation after digit splitting
        // When "326973 da3" is split to "32 69 73 da3", the "da3" still needs separating
        // Case 1: digit directly before da (e.g. "73da3" → "73 da 3")
        // Case 2: space before da, digits after (e.g. " da3" → " da 3")
        prev = formatted;
        formatted = formatted.replace(/(\d)(da)([0-9,']+)/gi, "$1 da $3");
        formatted = formatted.replace(/(\d)(da)\b/gi, "$1 da");
        formatted = formatted.replace(/\b(da)([0-9,']+)/gi, "da $2");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Split remaining 4+ consecutive digits into pairs (ONLY when line contains 'da')
        // e.g. "5191 da 10" → "51 91 da 10", but "5191 b 10" stays as-is
        if (/\bda\b/i.test(formatted)) {
            // Sub-rule: Normalize '.' separator between 4+ digit sequences to ';' (da lines only)
            // e.g. "8886.9092.3232 da 2" → "8886;9092;3232 da 2" → then split into pairs
            // BUT "12.34" (2-digit pairs) stays as-is
            prev = formatted;
            formatted = formatted.replace(/(\d{4,})\.(?=\d{4,})/g, "$1;");
            if (formatted !== prev) wasFormatted = true;
            prev = formatted;
            formatted = formatted.replace(/\d{4,}/g, function (match) {
                if (match.length % 2 !== 0) {
                    errors.push("Odd digit count: \"" + match + "\"");
                    return match;
                }
                var pairs = [];
                for (var i = 0; i < match.length; i += 2) {
                    pairs.push(match.substr(i, 2));
                }
                return pairs.join(" ");
            });
            if (formatted !== prev) wasFormatted = true;
        }

        // Rule: When line contains 'da', convert '05' or "0'5" to '0,5' ONLY after 'da'
        // e.g. "89 98 da 05" → "89 98 da 0,5", "89 98 da 0'5" → "89 98 da 0,5"
        // BUT "05 da 10" → "05" stays untouched (before da)
        if (/\bda\b/i.test(formatted)) {
            prev = formatted;
            formatted = formatted.replace(/(\bda\b.*?)(?<!\d)0'5(?!\d)/gi, "$10,5");
            formatted = formatted.replace(/(\bda\b.*?)(?<!\d)05(?!\d)/gi, "$10,5");
            if (formatted !== prev) wasFormatted = true;
        }

        // Rule: In da lines, convert comma to dot in amount after 'da'
        // e.g. "da 2,5" → "da 2.5", "da 0,5" → "da 0.5"
        if (/\bda\b/i.test(formatted)) {
            prev = formatted;
            formatted = formatted.replace(/(\bda\s+\d+),(\d+)/gi, "$1.$2");
            if (formatted !== prev) wasFormatted = true;
        }

        // Rule: '/' → ';'
        prev = formatted;
        formatted = formatted.replace(/\//g, ";");
        if (formatted !== prev) wasFormatted = true;

        // Rule: Strip 'x' prefix from xduoi/xdui/xdau when ALL number tokens are 2-digit
        // The 'x' prefix (xiên) is only valid for 3-digit numbers.
        // e.g. "11 00 xduoi 300" → "11 00 duoi 300" (2-digit numbers → strip x)
        // but  "786 xduoi 300" stays as-is (3-digit number → keep x)
        // Compound keywords like xduoidao/xdaudao are NOT affected.
        (function () {
            var numberTokens = formatted.match(/\b\d{2,3}\b/g);
            if (numberTokens && numberTokens.length > 0) {
                var hasThreeDigit = numberTokens.some(function (t) { return t.length === 3; });
                if (!hasThreeDigit) {
                    prev = formatted;
                    // Strip x from xduoi/xdui/xdau but NOT from xduoidao/xdaudao/xdaodau/xdaodui/xdaoduoi
                    formatted = formatted.replace(/\bxduoi\b/gi, "duoi");
                    formatted = formatted.replace(/\bxdui\b/gi, "dui");
                    formatted = formatted.replace(/\bxdau\b/gi, "dau");
                    if (formatted !== prev) wasFormatted = true;
                }
            }
        })();

        formattedLines.push(formatted);
    }

    return { formatted: formattedLines.join("\n"), wasFormatted: wasFormatted, errors: errors };
}

// Mức trừ theo số lượng số
const SUBTRACT = {
    3: 15,
    4: 8,
    5: 5,
    6: 4
};



// Parse a da line → { nums: ['02','20','27','72'], aa: 40, line: original }
function parseDaLine(line) {
    const parts = line.trim().split(/\s+/);
    const daIndex = parts.findIndex(p => p.toLowerCase() === 'da');
    if (daIndex === -1) return null;

    const numTokens = parts.slice(0, daIndex).join(' ').replace(/\./g, ' ').trim().split(/\s+/).filter(p => /^\d+$/.test(p));
    const aa = parseFloat(parts.slice(daIndex + 1).join(''));
    return { nums: numTokens.sort(), count: numTokens.length, aa, parts, daIndex, line };
}

// Generate all pairs (combo C(n,2)) from array
function getPairs(arr) {
    let pairs = [];
    for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
            pairs.push(`${arr[i]}-${arr[j]}`);
        }
    }
    return pairs;
}

// Main: sort → expand pairs → remove dups → subtract → output
function processDaLines(formattedText) {
    const allLines = formattedText.split('\n');
    const daEntries = [];
    const nonDaResult = []; // track non-da lines with their indices

    // Step 1: Parse all da lines with 3-6 numbers
    allLines.forEach((line, idx) => {
        if (/\bda\b/i.test(line)) {
            const parsed = parseDaLine(line);
            if (parsed && parsed.count >= 3 && parsed.count <= 6) {
                daEntries.push({ ...parsed, idx });
                return;
            }
        }
        nonDaResult.push({ idx, line });
    });

    // Step 2: Sort by count DESC (6→5→4→3) for priority
    daEntries.sort((a, b) => b.count - a.count);

    // Step 3: Process each entry — expand pairs, remove dups, subtract
    const usedPairs = new Set();
    const resultEntries = []; // { idx, output }

    daEntries.forEach(entry => {
        const allPairs = getPairs(entry.nums); // sorted pairs like "02-20"
        const newPairs = allPairs.filter(pair => !usedPairs.has(pair));

        if (newPairs.length === 0) {
            // Fully duplicate — skip entirely
            return;
        }

        // Mark all pairs as used (even if some were already used)
        allPairs.forEach(pair => usedPairs.add(pair));

        // Subtract rate
        const rate = SUBTRACT[entry.count] || 0;
        const newAa = entry.aa - rate;

        // Format: "02 20; 02 27; 02 72 dx 32n"
        const pairsStr = newPairs.map(p => p.replace('-', ' ')).join('; ');
        resultEntries.push({ idx: entry.idx, output: `${pairsStr} dx ${newAa}n` });
    });

    // Step 4: Merge non-da lines and processed da lines in original order
    const allResults = [...nonDaResult.map(r => ({ idx: r.idx, output: r.line })), ...resultEntries];
    allResults.sort((a, b) => a.idx - b.idx);

    return allResults.map(r => r.output).join('\n');
}

// Interactive CLI
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("=== CĂN ĂN MỨC - TEST CLI ===");
console.log("Nhập dữ liệu (paste nhiều dòng), gõ 'done' để xử lý:\n");

let inputLines = [];

rl.on('line', (line) => {
    if (line.trim().toLowerCase() === 'done') {
        const rawText = inputLines.join('\n');
        const { formatted, errors } = formatInputMessage(rawText);

        const result = processDaLines(formatted);

        console.log("\n--- RESULT ---");
        console.log(result);
        if (errors.length) console.log("⚠️  Errors:", errors);

        inputLines = [];
        console.log("\n--- Nhập tiếp hoặc Ctrl+C để thoát ---\n");
    } else {
        inputLines.push(line);
    }
});