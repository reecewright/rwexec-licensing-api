import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const products = [
    { slug: "rwexec-reservations", name: "RWExec Reservations", description: "Restaurant reservations for WordPress." },
    { slug: "rwexec-signage", name: "RWExec Signage", description: "Cloud-managed digital signage and screen devices." }
  ];

  for (const data of products) {
    const product = await prisma.product.upsert({ where: { slug: data.slug }, update: { name: data.name, description: data.description }, create: data });
    console.log(`Seeded product: ${product.slug}`);
  }
}

main().finally(async () => prisma.$disconnect());
