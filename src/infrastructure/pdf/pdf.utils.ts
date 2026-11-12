import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";

export type ModifyPromoCodePdfParams = {
    promoCode?: string | null;
    templateBuffer: Buffer;
    templateKey?: string | null;
};

// These verified historical templates share the printed code line from Klei's
// original artwork. Scope its corrected placement to the saved template key;
// other studios' uploaded PDFs keep their existing coordinates.
const KLEI_LEGACY_TEMPLATES = new Set([
    "coupon-templates/Atelier_Klei_Poukaz_04_Toceni_na_kruhu_pro_zacatecniky.pdf",
    "coupon-templates/Atelier_Klei_Poukaz_06_Glazovani.pdf",
    "coupon-templates/Atelier_Klei_Poukaz_07_Clay_play_Zakladni_modelovani.pdf",
    "coupon-templates/poukaz-v-hodnot-500-k-e817b36e-09dc-41ac-bb32-7bf680dfacc7.pdf",
    "coupon-templates/Atelier_Klei_Poukaz_1500_Kc.pdf",
    "coupon-templates/Atelier_Klei_Poukaz_2000_Kc.pdf",
    "coupon-templates/Atelier_Klei_Poukaz_1000_Kc.pdf",
]);

export const modifyPromoCodePdf = async ({
    promoCode,
    templateBuffer,
    templateKey,
}: ModifyPromoCodePdfParams): Promise<Buffer> => {
    if (!Buffer.isBuffer(templateBuffer)) {
        throw new Error("modifyPromoCodePdf: templateBuffer must be a Buffer");
    }

    const safePromoCode = String(promoCode ?? "NaN").trim() || "NaN";

    const pdfDoc = await PDFDocument.load(templateBuffer);
    const pages = pdfDoc.getPages();

    if (pages.length === 0) {
        throw new Error("modifyPromoCodePdf: PDF has no pages");
    }

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const firstPage = pages[0];
    const media = firstPage.getMediaBox();
    const crop = firstPage.getCropBox();
    const matchesLegacyPage = [media, crop].every((box) =>
        Math.abs(box.x) < 0.01 && Math.abs(box.y) < 0.01 &&
        Math.abs(box.width - 595.2) < 0.01 && Math.abs(box.height - 283.44) < 0.01,
    ) && firstPage.getRotation().angle === 0;
    let placement = { x: 428, y: 17, size: 8 };
    if (KLEI_LEGACY_TEMPLATES.has(String(templateKey ?? "")) && matchesLegacyPage) {
        const codeLine = { left: 401, right: 572.28, y: 21.5 };
        const size = Math.min(8.5, (codeLine.right - codeLine.left) / font.widthOfTextAtSize(safePromoCode, 1));
        const textWidth = font.widthOfTextAtSize(safePromoCode, size);
        placement = {
            x: (codeLine.left + codeLine.right - textWidth) / 2,
            y: codeLine.y + 4.5,
            size,
        };
    }

    firstPage.drawText(safePromoCode, {
        ...placement,
        font,
        color: rgb(0, 0, 0),
        rotate: degrees(0),
    });

    const pdfBytes = await pdfDoc.save();

    return Buffer.from(pdfBytes);
};
