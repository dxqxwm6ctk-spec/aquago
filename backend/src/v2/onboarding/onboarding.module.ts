import { Module } from '@nestjs/common';
import {
  AgencyOnboardingController,
  PlatformOnboardingController,
} from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
  controllers: [AgencyOnboardingController, PlatformOnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingV2Module {}
