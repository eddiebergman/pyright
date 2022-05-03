/*
 * protocols.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Provides type evaluation logic that is specific to protocol
 * (structural subtyping) classes.
 */

import { assert } from '../common/debug';
import { DiagnosticAddendum } from '../common/diagnostic';
import { Localizer } from '../localization/localize';
import { DeclarationType } from './declaration';
import { canAssignProperty } from './properties';
import { TypeEvaluator } from './typeEvaluatorTypes';
import {
    ClassType,
    isClassInstance,
    isFunction,
    isInstantiableClass,
    isOverloadedFunction,
    isTypeSame,
    maxTypeRecursionCount,
    ModuleType,
    Type,
    UnknownType,
} from './types';
import {
    applySolvedTypeVars,
    buildTypeVarContextFromSpecializedClass,
    CanAssignFlags,
    ClassMember,
    containsLiteralType,
    getTypeVarScopeId,
    lookUpClassMember,
    partiallySpecializeType,
    populateTypeVarContextForSelfType,
    removeParamSpecVariadicsFromSignature,
    specializeForBaseClass,
} from './typeUtils';
import { TypeVarContext } from './typeVarContext';

interface ProtocolAssignmentStackEntry {
    srcType: ClassType;
    destType: ClassType;
}

const protocolAssignmentStack: ProtocolAssignmentStackEntry[] = [];

// If treatSourceAsInstantiable is true, we're comparing the class object against the
// protocol. If it's false, we're comparing the class instance against the protocol.
export function canAssignClassToProtocol(
    evaluator: TypeEvaluator,
    destType: ClassType,
    srcType: ClassType,
    diag: DiagnosticAddendum | undefined,
    typeVarContext: TypeVarContext | undefined,
    flags: CanAssignFlags,
    treatSourceAsInstantiable: boolean,
    recursionCount: number
): boolean {
    if (recursionCount > maxTypeRecursionCount) {
        return true;
    }
    recursionCount++;

    // Use a stack of pending protocol class evaluations to detect recursion.
    // This can happen when a protocol class refers to itself.
    if (
        protocolAssignmentStack.some((entry) => {
            return isTypeSame(entry.srcType, srcType) && isTypeSame(entry.destType, destType);
        })
    ) {
        return true;
    }

    protocolAssignmentStack.push({ srcType, destType });
    let isCompatible = true;

    try {
        isCompatible = canAssignClassToProtocolInternal(
            evaluator,
            destType,
            srcType,
            diag,
            typeVarContext,
            flags,
            treatSourceAsInstantiable,
            recursionCount
        );
    } catch (e) {
        // We'd normally use "finally" here, but the TS debugger does such
        // a poor job dealing with finally, we'll use a catch instead.
        protocolAssignmentStack.pop();
        throw e;
    }

    protocolAssignmentStack.pop();

    return isCompatible;
}

function canAssignClassToProtocolInternal(
    evaluator: TypeEvaluator,
    destType: ClassType,
    srcType: ClassType,
    diag: DiagnosticAddendum | undefined,
    typeVarContext: TypeVarContext | undefined,
    flags: CanAssignFlags,
    treatSourceAsInstantiable: boolean,
    recursionCount: number
): boolean {
    if ((flags & CanAssignFlags.EnforceInvariance) !== 0) {
        return isTypeSame(destType, srcType);
    }

    // Strip the type arguments off the dest protocol if they are provided.
    const genericDestType = ClassType.cloneForSpecialization(destType, undefined, /* isTypeArgumentExplicit */ false);
    const genericDestTypeVarContext = new TypeVarContext(getTypeVarScopeId(destType));

    const selfTypeVarContext = new TypeVarContext(getTypeVarScopeId(destType));
    populateTypeVarContextForSelfType(selfTypeVarContext, destType, srcType);

    // If the source is a TypedDict, use the _TypedDict placeholder class
    // instead. We don't want to use the TypedDict members for protocol
    // comparison.
    if (ClassType.isTypedDictClass(srcType)) {
        const typedDictClassType = evaluator.getTypedDictClassType();
        if (typedDictClassType && isInstantiableClass(typedDictClassType)) {
            srcType = typedDictClassType;
        }
    }

    let typesAreConsistent = true;
    const checkedSymbolSet = new Set<string>();
    const srcClassTypeVarContext = buildTypeVarContextFromSpecializedClass(srcType);
    const canAssignFlags = containsLiteralType(srcType, /* includeTypeArgs */ true)
        ? CanAssignFlags.RetainLiteralsForTypeVar
        : CanAssignFlags.Default;

    destType.details.mro.forEach((mroClass) => {
        if (!isInstantiableClass(mroClass) || !ClassType.isProtocolClass(mroClass)) {
            return;
        }

        mroClass.details.fields.forEach((symbol, name) => {
            if (symbol.isClassMember() && !symbol.isIgnoredForProtocolMatch() && !checkedSymbolSet.has(name)) {
                let isMemberFromMetaclass = false;
                let srcMemberInfo: ClassMember | undefined;

                // Special-case the `__class_getitem__` for normal protocol comparison.
                // This is a convention agreed upon by typeshed maintainers.
                if (!treatSourceAsInstantiable && name === '__class_getitem__') {
                    return;
                }

                // Special-case the `__slots__` entry for all protocol comparisons.
                // This is a convention agreed upon by typeshed maintainers.
                if (name === '__slots__') {
                    return;
                }

                // Note that we've already checked this symbol. It doesn't need to
                // be checked again even if it is declared by a subclass.
                checkedSymbolSet.add(name);

                // Look in the metaclass first if we're treating the source as an instantiable class.
                if (
                    treatSourceAsInstantiable &&
                    srcType.details.effectiveMetaclass &&
                    isInstantiableClass(srcType.details.effectiveMetaclass)
                ) {
                    srcMemberInfo = lookUpClassMember(srcType.details.effectiveMetaclass, name);
                    if (srcMemberInfo) {
                        srcClassTypeVarContext.addSolveForScope(getTypeVarScopeId(srcType.details.effectiveMetaclass));
                        isMemberFromMetaclass = true;
                    }
                }

                if (!srcMemberInfo) {
                    srcMemberInfo = lookUpClassMember(srcType, name);
                }

                if (!srcMemberInfo) {
                    if (diag) {
                        diag.addMessage(Localizer.DiagnosticAddendum.protocolMemberMissing().format({ name }));
                    }
                    typesAreConsistent = false;
                } else {
                    let destMemberType = evaluator.getDeclaredTypeOfSymbol(symbol);
                    if (destMemberType) {
                        // Partially specialize the type of the symbol based on the MRO class.
                        // We can skip this if it's the dest class because it is already
                        // specialized.
                        if (!ClassType.isSameGenericClass(mroClass, destType)) {
                            destMemberType = partiallySpecializeType(destMemberType, mroClass);
                        }

                        let srcMemberType: Type;
                        if (isInstantiableClass(srcMemberInfo.classType)) {
                            const symbolType = evaluator.getEffectiveTypeOfSymbol(srcMemberInfo.symbol);

                            // If this is a function, infer its return type prior to specializing it.
                            if (isFunction(symbolType)) {
                                evaluator.inferReturnTypeIfNecessary(symbolType);
                            }

                            srcMemberType = partiallySpecializeType(symbolType, srcMemberInfo.classType, srcType);
                        } else {
                            srcMemberType = UnknownType.create();
                        }

                        if (isFunction(srcMemberType) || isOverloadedFunction(srcMemberType)) {
                            if (isMemberFromMetaclass) {
                                const boundSrcFunction = evaluator.bindFunctionToClassOrObject(
                                    srcType,
                                    srcMemberType,
                                    /* memberClass */ undefined,
                                    /* errorNode */ undefined,
                                    recursionCount,
                                    /* treatConstructorAsClassMember */ false,
                                    srcType
                                );
                                if (boundSrcFunction) {
                                    srcMemberType = removeParamSpecVariadicsFromSignature(boundSrcFunction);
                                }

                                if (isFunction(destMemberType) || isOverloadedFunction(destMemberType)) {
                                    const boundDeclaredType = evaluator.bindFunctionToClassOrObject(
                                        srcType,
                                        destMemberType,
                                        /* memberClass */ undefined,
                                        /* errorNode */ undefined,
                                        recursionCount,
                                        /* treatConstructorAsClassMember */ false,
                                        srcType
                                    );
                                    if (boundDeclaredType) {
                                        destMemberType = removeParamSpecVariadicsFromSignature(boundDeclaredType);
                                    }
                                }
                            } else if (isInstantiableClass(srcMemberInfo.classType)) {
                                // Replace any "Self" TypeVar within the dest with the source type.
                                destMemberType = applySolvedTypeVars(destMemberType, selfTypeVarContext);

                                const boundSrcFunction = evaluator.bindFunctionToClassOrObject(
                                    treatSourceAsInstantiable ? srcType : ClassType.cloneAsInstance(srcType),
                                    srcMemberType,
                                    srcMemberInfo.classType,
                                    /* errorNode */ undefined,
                                    recursionCount
                                );
                                if (boundSrcFunction) {
                                    srcMemberType = removeParamSpecVariadicsFromSignature(boundSrcFunction);
                                }

                                if (isFunction(destMemberType) || isOverloadedFunction(destMemberType)) {
                                    const boundDeclaredType = evaluator.bindFunctionToClassOrObject(
                                        ClassType.cloneAsInstance(srcType),
                                        destMemberType,
                                        srcMemberInfo.classType,
                                        /* errorNode */ undefined,
                                        recursionCount
                                    );
                                    if (boundDeclaredType) {
                                        destMemberType = removeParamSpecVariadicsFromSignature(boundDeclaredType);
                                    }
                                }
                            }
                        } else {
                            // Replace any "Self" TypeVar within the dest with the source type.
                            destMemberType = applySolvedTypeVars(destMemberType, selfTypeVarContext);
                        }

                        const subDiag = diag?.createAddendum();

                        // Properties require special processing.
                        if (isClassInstance(destMemberType) && ClassType.isPropertyClass(destMemberType)) {
                            if (
                                isClassInstance(srcMemberType) &&
                                ClassType.isPropertyClass(srcMemberType) &&
                                !treatSourceAsInstantiable
                            ) {
                                if (
                                    !canAssignProperty(
                                        evaluator,
                                        ClassType.cloneAsInstantiable(destMemberType),
                                        ClassType.cloneAsInstantiable(srcMemberType),
                                        mroClass,
                                        srcType,
                                        subDiag?.createAddendum(),
                                        genericDestTypeVarContext,
                                        selfTypeVarContext,
                                        recursionCount
                                    )
                                ) {
                                    if (subDiag) {
                                        subDiag.addMessage(
                                            Localizer.DiagnosticAddendum.memberTypeMismatch().format({ name })
                                        );
                                    }
                                    typesAreConsistent = false;
                                }
                            } else {
                                // Extract the property type from the property class.
                                const getterType = evaluator.getGetterTypeFromProperty(
                                    destMemberType,
                                    /* inferTypeIfNeeded */ true
                                );
                                if (
                                    !getterType ||
                                    !evaluator.canAssignType(
                                        getterType,
                                        srcMemberType,
                                        subDiag?.createAddendum(),
                                        genericDestTypeVarContext,
                                        canAssignFlags,
                                        recursionCount
                                    )
                                ) {
                                    if (subDiag) {
                                        subDiag.addMessage(
                                            Localizer.DiagnosticAddendum.memberTypeMismatch().format({ name })
                                        );
                                    }
                                    typesAreConsistent = false;
                                }
                            }
                        } else {
                            // Class and instance variables that are mutable need to
                            // enforce invariance.
                            const primaryDecl = symbol.getDeclarations()[0];
                            const isInvariant = primaryDecl?.type === DeclarationType.Variable && !primaryDecl.isFinal;
                            if (
                                !evaluator.canAssignType(
                                    destMemberType,
                                    srcMemberType,
                                    subDiag?.createAddendum(),
                                    genericDestTypeVarContext,
                                    isInvariant ? canAssignFlags | CanAssignFlags.EnforceInvariance : canAssignFlags,
                                    recursionCount
                                )
                            ) {
                                if (subDiag) {
                                    if (isInvariant) {
                                        subDiag.addMessage(
                                            Localizer.DiagnosticAddendum.memberIsInvariant().format({ name })
                                        );
                                    }
                                    subDiag.addMessage(
                                        Localizer.DiagnosticAddendum.memberTypeMismatch().format({ name })
                                    );
                                }
                                typesAreConsistent = false;
                            }
                        }

                        const isDestFinal = symbol
                            .getTypedDeclarations()
                            .some((decl) => decl.type === DeclarationType.Variable && !!decl.isFinal);
                        const isSrcFinal = srcMemberInfo.symbol
                            .getTypedDeclarations()
                            .some((decl) => decl.type === DeclarationType.Variable && !!decl.isFinal);

                        if (isDestFinal !== isSrcFinal) {
                            if (isDestFinal) {
                                if (subDiag) {
                                    subDiag.addMessage(
                                        Localizer.DiagnosticAddendum.memberIsFinalInProtocol().format({ name })
                                    );
                                }
                            } else {
                                if (subDiag) {
                                    subDiag.addMessage(
                                        Localizer.DiagnosticAddendum.memberIsNotFinalInProtocol().format({ name })
                                    );
                                }
                            }
                            typesAreConsistent = false;
                        }
                    }

                    if (symbol.isClassVar() && !srcMemberInfo.symbol.isClassMember()) {
                        if (diag) {
                            diag.addMessage(Localizer.DiagnosticAddendum.protocolMemberClassVar().format({ name }));
                        }
                        typesAreConsistent = false;
                    }
                }
            }
        });
    });

    // If the dest protocol has type parameters, make sure the source type arguments match.
    if (typesAreConsistent && destType.details.typeParameters.length > 0 && destType.typeArguments) {
        // Create a specialized version of the protocol defined by the dest and
        // make sure the resulting type args can be assigned.
        const specializedDestProtocol = applySolvedTypeVars(genericDestType, genericDestTypeVarContext) as ClassType;

        if (
            !evaluator.verifyTypeArgumentsAssignable(
                destType,
                specializedDestProtocol,
                diag,
                typeVarContext,
                flags,
                recursionCount
            )
        ) {
            typesAreConsistent = false;
        }
    }

    return typesAreConsistent;
}

export function canAssignModuleToProtocol(
    evaluator: TypeEvaluator,
    destType: ClassType,
    srcType: ModuleType,
    diag: DiagnosticAddendum | undefined,
    typeVarContext: TypeVarContext | undefined,
    flags: CanAssignFlags,
    recursionCount: number
): boolean {
    if (recursionCount > maxTypeRecursionCount) {
        return true;
    }
    recursionCount++;

    let typesAreConsistent = true;
    const checkedSymbolSet = new Set<string>();

    // Strip the type arguments off the dest protocol if they are provided.
    const genericDestType = ClassType.cloneForSpecialization(destType, undefined, /* isTypeArgumentExplicit */ false);
    const genericDestTypeVarContext = new TypeVarContext(getTypeVarScopeId(destType));

    destType.details.mro.forEach((mroClass) => {
        if (!isInstantiableClass(mroClass) || !ClassType.isProtocolClass(mroClass)) {
            return;
        }

        mroClass.details.fields.forEach((symbol, name) => {
            if (symbol.isClassMember() && !symbol.isIgnoredForProtocolMatch() && !checkedSymbolSet.has(name)) {
                // Note that we've already checked this symbol. It doesn't need to
                // be checked again even if it is declared by a subclass.
                checkedSymbolSet.add(name);

                const memberSymbol = srcType.fields.get(name);

                if (!memberSymbol) {
                    if (diag) {
                        diag.addMessage(Localizer.DiagnosticAddendum.protocolMemberMissing().format({ name }));
                    }
                    typesAreConsistent = false;
                } else {
                    let destMemberType = evaluator.getDeclaredTypeOfSymbol(symbol);
                    if (destMemberType) {
                        destMemberType = partiallySpecializeType(destMemberType, destType);

                        const srcMemberType = evaluator.getEffectiveTypeOfSymbol(memberSymbol);

                        if (isFunction(srcMemberType) || isOverloadedFunction(srcMemberType)) {
                            if (isFunction(destMemberType) || isOverloadedFunction(destMemberType)) {
                                const boundDeclaredType = evaluator.bindFunctionToClassOrObject(
                                    ClassType.cloneAsInstance(destType),
                                    destMemberType,
                                    destType,
                                    /* errorNode */ undefined,
                                    recursionCount
                                );
                                if (boundDeclaredType) {
                                    destMemberType = boundDeclaredType;
                                }
                            }
                        }

                        const subDiag = diag?.createAddendum();

                        if (
                            !evaluator.canAssignType(
                                destMemberType,
                                srcMemberType,
                                subDiag?.createAddendum(),
                                genericDestTypeVarContext,
                                CanAssignFlags.Default,
                                recursionCount
                            )
                        ) {
                            if (subDiag) {
                                subDiag.addMessage(Localizer.DiagnosticAddendum.memberTypeMismatch().format({ name }));
                            }
                            typesAreConsistent = false;
                        }
                    }
                }
            }
        });
    });

    // If the dest protocol has type parameters, make sure the source type arguments match.
    if (typesAreConsistent && destType.details.typeParameters.length > 0 && destType.typeArguments) {
        // Create a specialized version of the protocol defined by the dest and
        // make sure the resulting type args can be assigned.
        const specializedSrcProtocol = applySolvedTypeVars(genericDestType, genericDestTypeVarContext) as ClassType;

        if (
            !evaluator.verifyTypeArgumentsAssignable(
                destType,
                specializedSrcProtocol,
                diag,
                typeVarContext,
                flags,
                recursionCount
            )
        ) {
            typesAreConsistent = false;
        }
    }

    return typesAreConsistent;
}

// This function is used to validate the variance of type variables
// within a protocol class.
export function canAssignProtocolClassToSelf(
    evaluator: TypeEvaluator,
    destType: ClassType,
    srcType: ClassType,
    recursionCount = 0
): boolean {
    assert(ClassType.isProtocolClass(destType));
    assert(ClassType.isProtocolClass(srcType));
    assert(ClassType.isSameGenericClass(destType, srcType));
    assert(destType.details.typeParameters.length > 0);

    const diag = new DiagnosticAddendum();
    const typeVarContext = new TypeVarContext();
    let isAssignable = true;

    destType.details.fields.forEach((symbol, name) => {
        if (isAssignable && symbol.isClassMember() && !symbol.isIgnoredForProtocolMatch()) {
            const memberInfo = lookUpClassMember(srcType, name);
            assert(memberInfo !== undefined);

            let destMemberType = evaluator.getDeclaredTypeOfSymbol(symbol);
            if (destMemberType) {
                const srcMemberType = evaluator.getTypeOfMember(memberInfo!);
                destMemberType = partiallySpecializeType(destMemberType, destType);

                // Properties require special processing.
                if (
                    isClassInstance(destMemberType) &&
                    ClassType.isPropertyClass(destMemberType) &&
                    isClassInstance(srcMemberType) &&
                    ClassType.isPropertyClass(srcMemberType)
                ) {
                    if (
                        !canAssignProperty(
                            evaluator,
                            ClassType.cloneAsInstantiable(destMemberType),
                            ClassType.cloneAsInstantiable(srcMemberType),
                            destType,
                            srcType,
                            diag,
                            typeVarContext,
                            /* selfTypeVarContext */ undefined,
                            recursionCount
                        )
                    ) {
                        isAssignable = false;
                    }
                } else {
                    const primaryDecl = symbol.getDeclarations()[0];
                    // Class and instance variables that are mutable need to
                    // enforce invariance.
                    const flags =
                        primaryDecl?.type === DeclarationType.Variable && !primaryDecl.isFinal
                            ? CanAssignFlags.EnforceInvariance
                            : CanAssignFlags.Default;
                    if (
                        !evaluator.canAssignType(
                            destMemberType,
                            srcMemberType,
                            diag,
                            typeVarContext,
                            flags,
                            recursionCount
                        )
                    ) {
                        isAssignable = false;
                    }
                }
            }
        }
    });

    // Now handle generic base classes.
    destType.details.baseClasses.forEach((baseClass) => {
        if (
            isInstantiableClass(baseClass) &&
            ClassType.isProtocolClass(baseClass) &&
            !ClassType.isBuiltIn(baseClass, 'object') &&
            !ClassType.isBuiltIn(baseClass, 'Protocol') &&
            baseClass.details.typeParameters.length > 0
        ) {
            const specializedDestBaseClass = specializeForBaseClass(destType, baseClass);
            const specializedSrcBaseClass = specializeForBaseClass(srcType, baseClass);
            if (
                !canAssignProtocolClassToSelf(
                    evaluator,
                    specializedDestBaseClass,
                    specializedSrcBaseClass,
                    recursionCount
                )
            ) {
                isAssignable = false;
            }
        }
    });

    return isAssignable;
}
