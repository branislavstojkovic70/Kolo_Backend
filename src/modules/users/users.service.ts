import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateMeDto } from './dto/update-me.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  toPublic(user: User) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      imageUrl: user.imageUrl,
      telegramUsername: user.telegramUsername,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  async updateMe(userId: string, dto: UpdateMeDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        username: dto.username,
        telegramUsername: dto.telegramUsername?.replace(/^@/, ''),
      },
    });
    return this.toPublic(user);
  }
}
