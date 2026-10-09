import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { toFixed2 } from '../../common/money';

interface CatalogEntry {
  slug: string;
  name: string;
  category: string;
  retailPriceUsd: string;
  imageUrl?: string;
}

export const PRODUCT_SELECT = {
  id: true,
  slug: true,
  name: true,
  category: true,
  retailPriceUsd: true,
  imageUrl: true,
} satisfies Prisma.ProductSelect;

type SelectedProduct = Prisma.ProductGetPayload<{
  select: typeof PRODUCT_SELECT;
}>;

/** Shared by every module that embeds a product in a response. */
export const mapProduct = (p: SelectedProduct) => ({
  ...p,
  retailPriceUsd: toFixed2(p.retailPriceUsd),
});

@Injectable()
export class ProductsService implements OnModuleInit {
  private readonly logger = new Logger(ProductsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Boot-time catalog sync: upsert every prisma/products.json entry by slug.
   * Idempotent — rerunning updates name/category/price in place, never duplicates.
   * A changed price only affects the catalog; order snapshots are untouched.
   */
  async onModuleInit() {
    // Serverless cold starts would re-run this on every new instance, and the
    // JSON file is not bundled into the Vercel function. There the catalog comes
    // from `npx prisma db seed` against the production database instead.
    if (process.env.VERCEL) return;

    let catalog: CatalogEntry[];
    try {
      catalog = JSON.parse(
        readFileSync(join(process.cwd(), 'prisma', 'products.json'), 'utf8'),
      ) as CatalogEntry[];
    } catch (e) {
      this.logger.error(
        `Could not read prisma/products.json: ${(e as Error).message}`,
      );
      return;
    }

    for (const p of catalog) {
      const data = {
        name: p.name,
        category: p.category,
        retailPriceUsd: new Prisma.Decimal(p.retailPriceUsd).toFixed(2),
        imageUrl: p.imageUrl ?? null,
        active: true,
      };
      await this.prisma.product.upsert({
        where: { slug: p.slug },
        create: { slug: p.slug, ...data },
        update: data,
      });
    }
    this.logger.log(`Product catalog synced — ${catalog.length} products`);
  }

  async findActive() {
    const products = await this.prisma.product.findMany({
      where: { active: true },
      select: PRODUCT_SELECT,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
    return products.map(mapProduct);
  }
}
