import { Module } from '@nestjs/common';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramWebhookController } from './telegram-webhook.controller';

@Module({
  controllers: [SupportController, TelegramWebhookController],
  providers: [SupportService, TelegramBotService],
  exports: [SupportService],
})
export class SupportV2Module {}
