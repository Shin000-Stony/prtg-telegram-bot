function isValidIPv4(ip) {

    const parts = ip.split(".");

    if (parts.length !== 4) {
        return false;
    }

    return parts.every(part => {

        if (!/^\d+$/.test(part)) {
            return false;
        }

        const value = Number(part);

        return value >= 0 && value <= 255;
    });
}

function normalizeServiceId(value) {

    const serviceId = value.trim();

    if (
        serviceId === "" ||
        serviceId === "-"
    ) {
        return null;
    }

    if (!/^\d{7,12}$/.test(serviceId)) {
        return undefined;
    }

    return serviceId;
}

module.exports = {
    isValidIPv4,
    normalizeServiceId
};