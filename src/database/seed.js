const db = require("./database");
const customers = require("./customers");

const seedCustomers = [
    {
        name: "RS UNIVERSITAS HASANUDDIN",
        ip: "183.91.66.98",
        location: "Makassar",
        service_id: "2023347917",
        description: "MAIN LINK"
    },
    {
        name: "SINAR TERANG MANDIRI",
        ip: "103.169.22.218",
        location: "Morowali",
        service_id: "2021289586",
        description: "MAIN LINK"
    },
    {
        name: "TAMACO GRAHA KRIDA",
        ip: "36.37.115.154",
        location: "Morowali",
        service_id: "2024416607",
        description: "MAIN LINK"
    },
    {
        name: "AQUILA COBALT NICKEL",
        ip: "103.191.8.70",
        location: "Morowali",
        service_id: "2023392903",
        description: "MAIN LINK"
    },
    {
        name: "METAL SMELTINDO SELARAS",
        ip: "182.23.13.74",
        location: "Morowali",
        service_id: "2024422995",
        description: "MAIN LINK"
    },
    {
        name: "METAL SMELTINDO SELARAS",
        ip: "182.23.40.250",
        location: "Morowali",
        service_id: "2025492539",
        description: "BACKUP LINK"
    },
    {
        name: "TEKNIK ALUM SERVICE",
        ip: "123.231.219.2",
        location: "Morowali",
        service_id: "2021255850",
        description: "MAIN LINK"
    },
    {
        name: "ANUGRAH AUTO SERVIS",
        ip: "103.189.94.106",
        location: "Morowali",
        service_id: "2022319993",
        description: "MAIN LINK"
    },
    {
        name: "BAHODOPI NICKEL SMELTING INDONESIA",
        ip: "103.239.215.170",
        location: "Morowali",
        service_id: "2026513717",
        description: "MAIN LINK"
    },
    {
        name: "META TELEKOMUNIKASI ASIA",
        ip: "103.188.36.194",
        location: "Morowali",
        service_id: "2024421449",
        description: "MAIN LINK"
    },
    {
        name: "HENGJAYA MINERALINDO",
        ip: "123.231.218.198",
        location: "Morowali",
        service_id: "2017004132",
        description: "MAIN LINK"
    },
    {
        name: "KANTOR OTBAN WILAYAH V",
        ip: "182.23.13.82",
        location: "Makassar",
        service_id: "2022300999",
        description: "MAIN LINK"
    },
    {
        name: "HONDA REMAJA JAYA",
        ip: "182.23.11.50",
        location: "Panaikang",
        service_id: "2023346550",
        description: "MAIN LINK"
    },
    {
        name: "SATUNOL DIGITAL TEKNOLOGI",
        ip: "103.102.48.242",
        location: "Pinrang",
        service_id: "2024418941",
        description: "MAIN LINK"
    },
    {
        name: "TRAVIRA AIR",
        ip: "103.252.86.242",
        location: "Jakarta",
        service_id: "2023356973",
        description: "MAIN LINK"
    },
    {
        name: "TRAVIRA AIR",
        ip: "123.231.255.122",
        location: "Jakarta",
        service_id: "2024430793",
        description: "BACKUP LINK"
    },
    {
        name: "UNIVERSITAS MUSLIM INDONESIA",
        ip: "123.231.157.86",
        location: "Makassar",
        service_id: "2022340441",
        description: "LINK LA"
    },
    {
        name: "UNIVERSITAS MUSLIM INDONESIA",
        ip: "114.9.83.10",
        location: "Makassar",
        service_id: null,
        description: "LINK IOH"
    },
    {
        name: "UNIVERSITAS MUSLIM INDONESIA",
        ip: "36.64.252.26",
        location: "Makassar",
        service_id: null,
        description: "LINK TELKOM"
    },
    {
        name: "SANATEL",
        ip: "103.200.206.26",
        location: "Gedung Cyber",
        service_id: "2023382881",
        description: "MAIN LINK"
    },
    {
        name: "CITRA CELEBAS MULTIMEDIA",
        ip: "103.186.10.118",
        location: "Pettarani",
        service_id: "2025499622",
        description: "NAP 9 G"
    },
    {
        name: "SANATEL",
        ip: "123.231.137.158",
        location: "Gedung Duren 3",
        service_id: "2025467765",
        description: "Link NAP"
    },
    {
        name: "EASTERN PEARL FLOUR MILLS",
        ip: "182.23.68.242",
        location: "Makassar",
        service_id: "2015004916",
        description: "MAIN LINK"
    }
];

const seed = db.transaction(() => {

    const existing =
        customers.getCustomers();

    if (existing.length > 0) {

        console.log(
            `[SEED] Database sudah berisi ${existing.length} customer.`
        );

        console.log(
            "[SEED] Tidak melakukan insert ulang."
        );

        return;
    }

    for (const customer of seedCustomers) {

        customers.addCustomer(
            customer
        );
    }
});

seed();

console.log(
    `[SEED] ${seedCustomers.length} customer berhasil dimasukkan.`
);