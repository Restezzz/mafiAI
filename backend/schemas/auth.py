from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field, field_validator

from schemas.validators import strip_name_value


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    nickname: str = Field(min_length=1, max_length=32, description="Отображается в игре; уникальность не требуется")

    @field_validator("nickname")
    @classmethod
    def strip_nickname(cls, v: str) -> str:
        return strip_name_value(v, required=True)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class AuthResponse(BaseModel):
    user_id: str
    email: str
    nickname: str
    access_token: str
    refresh_token: str


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str


class MeResponse(BaseModel):
    user_id: str
    email: str
    nickname: str
    has_pro: bool
    created_at: str
    avatar_url: str | None = None


class UpdateAvatarRequest(BaseModel):
    # data:image/jpeg;base64,... — клиент сжимает картинку canvas'ом до ~50КБ.
    # None значит «удалить аватар».
    avatar_data_url: str | None = Field(
        default=None,
        max_length=200_000,
        description="data:image/...;base64,... URL или null для удаления",
    )

    @field_validator("avatar_data_url")
    @classmethod
    def validate_data_url(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not v.startswith("data:image/"):
            raise ValueError("avatar_data_url должен начинаться с data:image/")
        # минимальная sanity-проверка: должен быть base64-сегмент
        if ";base64," not in v:
            raise ValueError("avatar_data_url должен содержать ;base64, маркер")
        return v


class UpdateNicknameRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=32, description="Новый ник для отображения в игре и при join без name")

    @field_validator("nickname")
    @classmethod
    def strip_nickname(cls, v: str) -> str:
        return strip_name_value(v, required=True)


class DeleteAccountRequest(BaseModel):
    password: str = Field(min_length=1, description="Подтверждение паролем перед удалением")


class LogoutRequest(BaseModel):
    refresh_token: str

